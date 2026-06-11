/**
 * @open-cowork/executor — the Executor abstraction and its three
 * implementations: LocalExecutor (the user's own desktop), RemoteMachineExecutor
 * (a Coasty cloud machine), and BrowserExecutor (a Playwright page).
 */
export * from './executor';
export * from './remoteMachine';
export * from './browser';
export * from './local/bridge';
export * from './local/localExecutor';
export * from './local/windowsBridge';
export * from './local/unixBridges';
