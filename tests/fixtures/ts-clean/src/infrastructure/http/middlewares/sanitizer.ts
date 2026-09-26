import { Request, Response, NextFunction } from 'express';

// Sanitizer middleware rejecting null bytes in URLs
export function nullByteSanitizer(req: Request, res: Response, next: NextFunction) {
  if (req.url.includes('\0') || req.url.includes('%00')) {
    return res.status(400).json({ error: 'Null bytes are forbidden' });
  }
  next();
}
