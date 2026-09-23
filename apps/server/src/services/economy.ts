import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/index.js';
import { ledger, users, type LedgerKind } from '../db/schema.js';
import { conflict } from '../errors.js';

/**
 * Mock $CHAIN ledger. Every change to a balance goes through here, inside the
 * caller's transaction, and is mirrored as a ledger row. When the game moves
 * on-chain this module is what gets swapped for a wallet adapter.
 */

export async function debit(
  tx: Tx,
  userId: string,
  amount: number,
  kind: LedgerKind,
  refId: string | null,
): Promise<void> {
  if (amount < 0) throw new Error('debit amount must be >= 0');
  if (amount === 0) return;
  const rows = await tx
    .update(users)
    .set({ balance: sql`${users.balance} - ${amount}` })
    .where(sql`${users.id} = ${userId} AND ${users.balance} >= ${amount}`)
    .returning({ balance: users.balance });
  if (rows.length === 0)
    throw conflict('insufficient-balance', 'Not enough $CHAIN for this entry fee.');
  await tx.insert(ledger).values({ userId, amount: -amount, kind, refId });
}

export async function credit(
  tx: Tx,
  userId: string,
  amount: number,
  kind: LedgerKind,
  refId: string | null,
): Promise<void> {
  if (amount < 0) throw new Error('credit amount must be >= 0');
  if (amount === 0) return;
  await tx
    .update(users)
    .set({ balance: sql`${users.balance} + ${amount}` })
    .where(eq(users.id, userId));
  await tx.insert(ledger).values({ userId, amount, kind, refId });
}
