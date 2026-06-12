/**
 * Machines: provision/stop/terminate Coasty cloud VMs with explicit cost
 * confirmation, plus the wallet view. The machine rate is confirmed via the
 * confirmCostCents handshake; the backend re-checks everything.
 */
import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  MachineCard,
  Modal,
  Spinner,
  WalletCard,
  type MachineStatus,
} from '@open-cowork/ui';
import { getClient } from '../store';
import type { MachineDto, WalletDto } from '../api/client';

const RATES = { linux: 5, windows: 9 } as const;

export function MachinesPage() {
  const client = getClient();
  const [machines, setMachines] = useState<MachineDto[] | null>(null);
  const [wallet, setWallet] = useState<WalletDto | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [name, setName] = useState('cowork-vm');
  const [osType, setOsType] = useState<'linux' | 'windows'>('linux');
  const [ttlMinutes, setTtlMinutes] = useState<number>(120);
  const [pending, setPending] = useState(false);
  const [provisionError, setProvisionError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const res = await client.listMachines();
      setMachines(res.machines);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load machines');
    }
    try {
      setWallet(await client.wallet());
      setWalletError(null);
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : 'Wallet unavailable');
    }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, []);

  const provision = async () => {
    setPending(true);
    setProvisionError(null);
    try {
      await client.createMachine({
        displayName: name,
        osType,
        ttlMinutes,
        confirmCostCents: RATES[osType],
      });
      setProvisionOpen(false);
      await load();
    } catch (err) {
      setProvisionError(err instanceof Error ? err.message : 'Provisioning failed');
    } finally {
      setPending(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    }
  };

  if (error && machines === null) return <ErrorState message={error} onRetry={() => void load()} />;
  if (machines === null) return <Spinner aria-label="Loading machines" />;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Machines</h1>
        <Button onClick={() => setProvisionOpen(true)}>Provision machine</Button>
      </div>

      <WalletCard
        balanceCents={wallet?.balanceCents}
        spentThisMonthCents={wallet?.monthSpendCents}
        loading={wallet === null && walletError === null}
        error={walletError ?? undefined}
        onRetry={() => void load()}
      />
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      {machines.length === 0 ? (
        <EmptyState
          title="No machines"
          description="Provision a cloud VM for the agent to work on. Linux machines bill $0.05/hour while running."
        />
      ) : (
        <div className="grid-cards">
          {machines.map((m) => (
            <MachineCard
              key={m.id}
              machine={{
                id: m.id,
                displayName: m.display_name,
                status: m.status as MachineStatus,
                osType: m.os_type,
                centsPerHour: RATES[m.os_type],
              }}
              onStart={(machineId) => void act(() => client.startMachine(machineId))}
              onStop={(machineId) => void act(() => client.stopMachine(machineId))}
              onTerminate={(machineId) => void act(() => client.terminateMachine(machineId))}
            />
          ))}
        </div>
      )}

      <Modal open={provisionOpen} onClose={() => setProvisionOpen(false)} title="Provision a cloud machine">
        <div className="stack">
          <Field label="Name" required>
            {({ id }) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />}
          </Field>
          <Field label="Operating system">
            {({ id }) => (
              <select id={id} value={osType} onChange={(e) => setOsType(e.target.value as 'linux' | 'windows')}>
                <option value="linux">Linux — $0.05/hour running</option>
                <option value="windows">Windows — $0.09/hour running</option>
              </select>
            )}
          </Field>
          <Field label="Auto-terminate after (minutes)" hint="Bounds runtime spend; 5–10080.">
            {({ id }) => (
              <input
                id={id}
                type="number"
                min={5}
                max={10080}
                value={ttlMinutes}
                onChange={(e) => setTtlMinutes(Number(e.target.value))}
              />
            )}
          </Field>
          <Card>
            <strong>Cost:</strong> ${(RATES[osType] / 100).toFixed(2)}/hour while running, $0.01/hour
            stopped. Auto-terminates after {ttlMinutes} minutes. Provisioning requires a $0.20 wallet
            minimum (a gate, not a fee).
          </Card>
          {provisionError ? <ErrorState message={provisionError} /> : null}
          <div className="row">
            <Button onClick={() => void provision()} loading={pending} disabled={!name.trim()}>
              Confirm — provision at ${(RATES[osType] / 100).toFixed(2)}/hr
            </Button>
            <Button variant="secondary" onClick={() => setProvisionOpen(false)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
