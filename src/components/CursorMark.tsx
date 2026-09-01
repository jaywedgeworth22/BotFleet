import { cn } from "@/lib/cn";

interface IconProps {
  size?: number;
  className?: string;
}

export function CursorMark({ size = 16, className }: IconProps) {
  return (
    <img 
      src="/cursor-mark.png" 
      width={size} 
      height={size} 
      className={cn("object-contain", className)} 
      alt="Cursor"
      aria-hidden
    />
  );
}
