import type { HTMLAttributes, ReactNode } from 'react';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  hover?: boolean;
  children: ReactNode;
}

export function Card({ hover, className = '', children, ...props }: CardProps) {
  return (
    <div
      className={`rounded-xl bg-bg-card border border-border-default p-5 ${hover ? 'transition-all hover:border-accent/30 hover:shadow-lg hover:shadow-accent/5' : ''} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'accent';

const badgeStyles: Record<BadgeVariant, string> = {
  default: 'bg-bg-elevated text-muted border-border-default',
  success: 'bg-green-500/10 text-green-400 border-green-500/20',
  warning: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  error: 'bg-red-500/10 text-red-400 border-red-500/20',
  accent: 'bg-accent/10 text-accent border-accent/20',
};

export function Badge({
  variant = 'default',
  children,
  className = '',
}: {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-medium rounded-full border ${badgeStyles[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
