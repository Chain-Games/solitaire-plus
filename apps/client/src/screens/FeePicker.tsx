import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { Coin, Segmented } from '../shell/ui.js';

// Mirrors the server's ENTRY_FEES until /api/challenges/fees answers: no free rung — every challenge is staked.
const DEFAULT_FEES = [5, 10, 25, 50, 100];

/**
 * Entry fee as a segmented control with the pot preview underneath. `counts`
 * (open challenges per fee) shows as a live badge on each cell.
 */
export function FeePicker({
  value,
  onChange,
  counts,
  balance,
}: {
  value: number;
  onChange: (fee: number) => void;
  counts?: Readonly<Record<number, number>> | undefined;
  /** The player's balance, to show what is left after staking. */
  balance?: number | undefined;
}) {
  const [fees, setFees] = useState<number[]>(DEFAULT_FEES);
  useEffect(() => {
    let alive = true;
    api.fees().then(
      (r) => alive && setFees(r.fees),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  const pot = value * 2;
  return (
    <div className="fee">
      <Segmented
        label="Entry fee"
        tone="warm"
        value={value}
        onChange={onChange}
        options={fees.map((f) => ({
          value: f,
          label: String(f),
          hint: counts && counts[f] ? `${counts[f]} open` : undefined,
        }))}
      />
      <div className="pot" aria-live="polite">
        <Coin />
        <div>
          <div className="label">Winner takes</div>
          <div className="amount">{pot} $CHAIN</div>
        </div>
        {balance !== undefined && (
          <div className="stake">
            Your stake
            <b>{value === 0 ? 'Nothing' : `${value} $CHAIN`}</b>
          </div>
        )}
      </div>
    </div>
  );
}
