import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge class names: clsx resolves conditionals/arrays/objects, tailwind-merge
 * dedupes conflicting Tailwind utilities (last-wins). The standard shadcn helper.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
