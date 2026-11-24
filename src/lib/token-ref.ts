import { z } from 'zod';

/// The token that stands for a character on a board.
///
/// `asset:<key>` for one bought in the shop, `socle:<color>` for one of the
/// four the app gives everyone, which have no key of their own. Ownership is
/// not checked: the app only offers what the account holds, and a reference
/// to something else would merely be drawn as a plain token.
export const tokenRefSchema = z
  .string()
  .regex(/^(asset:[a-z0-9_]{1,80}|socle:(red|green|blue|yellow))$/, {
    message: 'Expected asset:<key> or socle:<color>',
  });
