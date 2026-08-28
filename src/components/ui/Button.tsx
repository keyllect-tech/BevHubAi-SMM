import { type ButtonHTMLAttributes, forwardRef, Fragment } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg' | 'icon';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-bg font-semibold hover:bg-accent-dim transition-colors accent-glow',
  secondary: 'bg-bg-elevated text-white border border-border-default hover:border-accent/40 transition-colors',
  ghost: 'text-muted hover:text-white hover:bg-bg-elevated transition-colors',
  danger: 'bg-red-600/90 text-white hover:bg-red-600 transition-colors',
  outline: 'border border-border-default text-white hover:border-accent/50 hover:text-accent transition-colors',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm rounded-lg',
  md: 'h-10 px-4 text-sm rounded-lg',
  lg: 'h-12 px-6 text-base rounded-xl',
  icon: 'h-9 w-9 rounded-lg',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading, className = '', children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-accent/30 ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      <Fragment>
        {loading && (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        )}
        {children}
      </Fragment>
    </button>
  )
);
Button.displayName = 'Button';
