import * as React from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Loader2, type LucideIcon } from 'lucide-react';

import { cn } from '@/shared/utils';
import { Button } from '@/shared/ui/Button';

type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

export type ActionMenuItem = {
  key: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  /** Drawn instead of `icon` for an icon that is not a Lucide component, such as a plugin's. */
  iconNode?: React.ReactNode;
  /** Set to make the item a radio choice; true marks the current one. */
  checked?: boolean;
  onSelect: () => void;
  disabled?: boolean;
  loading?: boolean;
  isDanger?: boolean;
  showDividerBefore?: boolean;
  closeOnSelect?: boolean;
};

type ActionMenuProps = {
  label: string;
  items: ActionMenuItem[];
  icon?: LucideIcon;
  ariaLabel?: string;
  align?: 'left' | 'right';
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  disabled?: boolean;
  iconOnly?: boolean;
  portal?: boolean;
  header?: React.ReactNode;
  /** Replaces the trigger's icon, label and chevron, e.g. with an avatar and a name. */
  triggerContent?: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
};

/**
 * Used by the mcp and sidebar modules for row "…" menus and the sidebar user menu, by
 * project-workspace for the header's tools menu, and by chat for the export menu.
 */
export function ActionMenu({
  label,
  items,
  icon: TriggerIcon,
  ariaLabel,
  align = 'right',
  variant = 'outline',
  size = 'sm',
  className,
  triggerClassName,
  menuClassName,
  disabled,
  iconOnly = false,
  portal = false,
  header,
  triggerContent,
  onOpenChange,
}: ActionMenuProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [portalPosition, setPortalPosition] = React.useState<{ top: number; left: number } | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  // Whether closing should move focus back to the trigger. Set for keyboard
  // (Escape) and item selection, but left false for outside pointer clicks so
  // focus is not stolen from wherever the user clicked.
  const restoreFocusRef = React.useRef(false);
  const focusMenuOnOpenRef = React.useRef(false);
  const wasOpenRef = React.useRef(false);
  const menuId = React.useId();

  const setMenuOpen = React.useCallback((open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setPortalPosition(null);
    }
    onOpenChange?.(open);
  }, [onOpenChange]);

  React.useEffect(() => {
    if (!isOpen) {
      return;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        rootRef.current
        && !rootRef.current.contains(target)
        && !menuRef.current?.contains(target)
      ) {
        setMenuOpen(false);
      }
    };

    // Captured on window and marked handled, so page-level Escape shortcuts
    // (the chat's abort) see that the menu already consumed it.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        restoreFocusRef.current = true;
        setMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    window.addEventListener('keydown', closeOnEscape, { capture: true });
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      window.removeEventListener('keydown', closeOnEscape, { capture: true });
    };
  }, [isOpen, setMenuOpen]);

  React.useEffect(() => {
    if (!isOpen || !portal) {
      return;
    }

    const closeOnViewportChange = () => setMenuOpen(false);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [isOpen, portal, setMenuOpen]);

  // Move focus into the menu on open and back to the trigger on a keyboard or
  // selection close, so keyboard and screen-reader navigation match the menu role.
  React.useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
      if (focusMenuOnOpenRef.current) {
        const menu = menuRef.current;
        const firstItem = menu?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not([disabled])');
        (firstItem ?? menu)?.focus();
      }
      return;
    }

    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      if (restoreFocusRef.current) {
        triggerRef.current?.focus();
      }
      restoreFocusRef.current = false;
    }
  }, [isOpen]);

  const runItem = (item: ActionMenuItem) => {
    if (item.disabled || item.loading) {
      return;
    }

    if (item.closeOnSelect !== false) {
      restoreFocusRef.current = true;
      setMenuOpen(false);
    }
    item.onSelect();
  };

  const toggleMenu = () => {
    if (isOpen) {
      setMenuOpen(false);
      return;
    }

    if (portal && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const menuWidth = 260;
      const estimatedHeight = (header ? 52 : 0)
        + items.reduce((height, item) => height + (item.description ? 58 : 40) + (item.showDividerBefore ? 9 : 0), 12);
      setPortalPosition({
        top: rect.bottom + 6 + estimatedHeight <= window.innerHeight - 8
          ? rect.bottom + 6
          : Math.max(8, rect.top - estimatedHeight - 6),
        left: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
      });
    }
    setMenuOpen(true);
  };

  const menu = isOpen && (!portal || portalPosition) && (
    <div
      ref={menuRef}
      id={menuId}
      role="menu"
      tabIndex={-1}
      data-escape-layer
      className={cn(
        portal ? 'fixed z-[70]' : 'absolute top-full z-50 mt-2',
        'min-w-[220px] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg',
        'animate-in fade-in-0 zoom-in-95',
        !portal && (align === 'right' ? 'right-0' : 'left-0'),
        menuClassName,
      )}
      style={portal && portalPosition ? portalPosition : undefined}
    >
      {header}
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <React.Fragment key={item.key}>
            {item.showDividerBefore && <div className="mx-2 my-1 h-px bg-border" />}
            <button
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={item.checked}
              disabled={item.disabled || item.loading}
              onClick={() => runItem(item)}
              className={cn(
                'flex w-full items-start gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors',
                'focus:outline-none focus-visible:bg-accent',
                item.disabled || item.loading
                  ? 'cursor-not-allowed opacity-50'
                  : item.isDanger
                    ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950'
                    : 'hover:bg-accent',
              )}
            >
              {item.loading ? (
                <Loader2 className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin" />
              ) : item.iconNode ? (
                <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center">{item.iconNode}</span>
              ) : (
                Icon && <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block font-medium leading-5">{item.label}</span>
                {item.description && (
                  <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                    {item.description}
                  </span>
                )}
              </span>
              {item.checked && <Check className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );

  return (
    <div ref={rootRef} className={cn('relative inline-flex', className)}>
      <Button
        ref={triggerRef}
        type="button"
        variant={variant}
        size={size}
        className={triggerClassName}
        disabled={disabled}
        aria-label={ariaLabel || label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        onClick={(event) => {
          focusMenuOnOpenRef.current = event.detail === 0;
          toggleMenu();
        }}
      >
        {triggerContent ?? (
          <>
            {TriggerIcon && <TriggerIcon className="h-4 w-4" />}
            {!iconOnly && (
              <>
                <span>{label}</span>
                <ChevronDown className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-180')} />
              </>
            )}
          </>
        )}
      </Button>

      {portal && typeof document !== 'undefined' ? createPortal(menu, document.body) : menu}
    </div>
  );
}
