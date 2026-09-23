import type { NextFunction, Request, Response } from 'express';

// Keyed by the real, trusted x-authentik-username -- see resolveAuthUser in
// auth.ts. Not persisted to disk: a server restart clears every active
// impersonation, which is treated as a feature (nothing survives a deploy
// silently). One entry per admin, one group at a time.
export type ImpersonationStore = Map<string, string>;

// Mounted immediately after requireAuth. When the calling user (identified
// by their real, header-verified username) has an active entry, overlays
// req.user.groups with just the impersonated group and stashes the real
// identity on req.realUser -- every existing permission check reads only
// req.user.groups, so this is the single point that makes the rest of the
// app behave as the impersonated group.
export function applyImpersonation(store: ImpersonationStore) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const group = req.user ? store.get(req.user.username) : undefined;
    if (group && req.user) {
      req.realUser = req.user;
      req.user = { ...req.user, groups: [group], impersonating: group };
    }
    next();
  };
}

// req.realUser is only set while an impersonation override is active --
// falling back to req.user covers the normal, non-impersonated case, where
// req.user already *is* the real identity. req.user?.impersonating is only
// ever set by the same applyImpersonation call that sets req.realUser, so
// reading it directly (rather than re-guarding on req.realUser) is
// equivalent and simpler. Returns keys matching JobDefinition's own field
// names exactly so call sites can spread this directly into their
// enqueue() object literal.
export function resolveTriggeredBy(
  req: Request,
): { triggeredByUsername?: string; triggeredByImpersonating?: string } {
  const real = req.realUser ?? req.user;
  return { triggeredByUsername: real?.username, triggeredByImpersonating: req.user?.impersonating };
}
