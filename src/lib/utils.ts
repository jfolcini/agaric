import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// The block text sizes (`src/index.css`) are font sizes; unknown, a `text-*`
// class reads as a colour and drops, or is dropped by, a real one.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['block-sm', 'block-chip'] }] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
