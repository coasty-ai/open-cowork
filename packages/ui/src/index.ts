/**
 * @open-cowork/ui — shared React component library + design system for the
 * web app, the desktop webview, and react-native-web.
 *
 * Import the stylesheet once per app: `import '@open-cowork/ui/styles.css'`.
 *
 * This package is intentionally independent of `@open-cowork/core`
 * (DECISIONS.md D9): domain components declare minimal local prop types
 * (RunStatus, MachineSummary, TimelineEvent, WorkflowStep, ...) and apps map
 * core's API types into them.
 */

// Brand
export { Logo } from './components/Logo';
export type { LogoProps } from './components/Logo';

// Typography
export { Heading } from './components/Heading';
export type { HeadingProps, HeadingLevel } from './components/Heading';
export { Text } from './components/Text';
export type { TextProps, TextVariant } from './components/Text';

// Primitives
export { Button } from './components/Button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './components/Button';
export { Card } from './components/Card';
export type { CardProps } from './components/Card';
export { Badge } from './components/Badge';
export type { BadgeProps, BadgeTone } from './components/Badge';
export { Spinner } from './components/Spinner';
export type { SpinnerProps } from './components/Spinner';
export { Modal } from './components/Modal';
export type { ModalProps } from './components/Modal';
export { Field } from './components/Field';
export type { FieldProps, FieldRenderProps } from './components/Field';
export { CodeBlock } from './components/CodeBlock';
export type { CodeBlockProps } from './components/CodeBlock';
export { Tabs } from './components/Tabs';
export type { TabItem, TabsProps } from './components/Tabs';
export { EmptyState } from './components/EmptyState';
export type { EmptyStateProps } from './components/EmptyState';
export { ErrorState } from './components/ErrorState';
export type { ErrorStateProps } from './components/ErrorState';
export { OfflineBanner } from './components/OfflineBanner';
export type { OfflineBannerProps } from './components/OfflineBanner';

// Domain components
export { RunStatusBadge } from './components/RunStatusBadge';
export type { RunStatus, RunStatusBadgeProps } from './components/RunStatusBadge';
export { CostPill, formatCents } from './components/CostPill';
export type { CostPillProps } from './components/CostPill';
export { EventTimeline } from './components/EventTimeline';
export type { EventTimelineProps, TimelineEvent } from './components/EventTimeline';
export { ScreenView } from './components/ScreenView';
export type { ScreenViewProps } from './components/ScreenView';
export { ApprovalBar } from './components/ApprovalBar';
export type { ApprovalBarProps } from './components/ApprovalBar';
export { WorkflowStepTree } from './components/WorkflowStepTree';
export type {
  WorkflowStep,
  WorkflowStepStatus,
  WorkflowStepTreeProps,
} from './components/WorkflowStepTree';
export { MachineCard } from './components/MachineCard';
export type { MachineCardProps, MachineStatus, MachineSummary } from './components/MachineCard';
export { WalletCard } from './components/WalletCard';
export type { WalletCardProps } from './components/WalletCard';
export { TaskComposer } from './components/TaskComposer';
export type {
  MachineOption,
  TaskComposerProps,
  TaskComposerSubmit,
} from './components/TaskComposer';
