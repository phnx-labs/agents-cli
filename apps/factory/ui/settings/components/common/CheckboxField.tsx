import React from 'react'
import { Checkbox } from '../ui/checkbox'

interface CheckboxFieldProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
  description?: string
  disabled?: boolean
  className?: string
}

/**
 * Checkbox with label pattern used throughout settings
 */
export function CheckboxField({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
  className = '',
}: CheckboxFieldProps) {
  return (
    <label className={`flex items-center gap-3 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${className}`}>
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        disabled={disabled}
      />
      <div className="flex-1">
        <span className="text-sm">{label}</span>
        {description && (
          <p className="text-xs text-[var(--muted-foreground)]">{description}</p>
        )}
      </div>
    </label>
  )
}
