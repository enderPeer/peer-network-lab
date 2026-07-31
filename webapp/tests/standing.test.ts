import { describe, it, expect } from 'vitest';
import {
  refRate,
  emission,
  Q,
  vouchAct,
  wallAct,
  solveStanding,
  evaluateGates,
  baseScoreMatrix,
  transport,
} from '../src/engine/standing';
import { SAFE_FLOOR } from '../src/engine/constants';
import { REFERENCE_EPOCH } from '../src/engine/fixtures';

const close = (actual: number, expected: number, tol = 2e-3) =>
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(tol);

describe('vouch activation curve (wall table)', () => {
  it('Q(1) normalization = 0.6975', () => close(Q(1), 0.6975, 5e-4));
  it('wall-clamped activation table', () => {
    close(wallAct(0), 0.8452, 5e-4); // constant below the wall
    close(wallAct(0.3), 0.8452, 5e-4);
    close(wallAct(SAFE_FLOOR), 0.8452, 5e-4);
    close(vouchAct(0.8), 0.8805, 5e-4);
    close(vouchAct(1.0), 0.8977, 5e-4);
    close(vouchAct(1.2), 0.9106, 5e-4);
    close(vouchAct(3.0), 0.9583, 5e-4);
  });
});

describe('ledger scalars', () => {
  it('reduced source rates of the reference epoch', () => {
    const [alice, bob, carol, dave, eve] = REFERENCE_EPOCH.ledgers;
    close(refRate(alice!), 1.0787, 5e-4);
    close(refRate(bob!), 1.1338, 5e-4);
    close(refRate(carol!), 1.1472, 5e-4);
    close(refRate(dave!), 1.0, 1e-9);
    close(refRate(eve!), 1.125, 1e-9);
  });
  it('all reference sources fully solvent → emission 1', () => {
    for (const l of REFERENCE_EPOCH.ledgers) expect(emission(l)).toBe(1);
  });
});

describe('conserved transport operator', () => {
  it('rows sum to 1 at arbitrary states', () => {
    const ids = REFERENCE_EPOCH.ledgers.map((l) => l.id);
    const base = baseScoreMatrix(ids, REFERENCE_EPOCH.cells);
    const x = [0.7, 1.3, 0.9, 2.0, 0.51];
    const pi = transport(base, x, [1, 1, 0.8, 1, 0.3], 1);
    for (const row of pi) {
      const sum = row.reduce((a, b) => a + b, 0);
      close(sum, 1, 1e-12);
    }
  });
});

describe('reference epoch equilibrium (Edition-4 solve)', () => {
  const result = solveStanding(REFERENCE_EPOCH.ledgers, REFERENCE_EPOCH.cells, { tilt: 1 });

  it('converges to the certified fixed point', () => {
    for (let i = 0; i < REFERENCE_EPOCH.expectedX.length; i++) {
      close(result.x[i]!, REFERENCE_EPOCH.expectedX[i]!, 1e-4);
    }
  });

  it('stays inside the contributing rate hull [1.0000, 1.1472]', () => {
    for (const v of result.x) {
      expect(v).toBeGreaterThanOrEqual(1.0 - 1e-9);
      expect(v).toBeLessThanOrEqual(1.1472 + 1e-9);
    }
  });

  it('epoch stamp 1.102 and headroom 0.615 clear the door', () => {
    const gates = evaluateGates(REFERENCE_EPOCH.ledgers, result.x, REFERENCE_EPOCH.deltaActs);
    close(gates.epochStamp, 1.102, 1e-3);
    close(gates.headroom, 0.615, 3e-3);
    expect(gates.w2bPass).toBe(true);
    expect(gates.allPass).toBe(true);
  });
});

describe('standing invariances', () => {
  it('equal-rate community stands exactly at the common rate', () => {
    const ledgers = [
      { id: 'a', burnBal: 0.6, actCount: 4 },
      { id: 'b', burnBal: 1.5, actCount: 10 },
      { id: 'c', burnBal: 0.3, actCount: 2 },
    ];
    const cells = [
      { src: 'a', rcp: 'b', coeff: 0.9 },
      { src: 'b', rcp: 'c', coeff: 0.4 },
      { src: 'c', rcp: 'a', coeff: 0.7 },
    ];
    const { x } = solveStanding(ledgers, cells, { tilt: 1 });
    for (const v of x) close(v, 1.5, 1e-10); // rate 0.15 / ν = 1.5
  });

  it('unembedded actor stands at own rate', () => {
    const ledgers = [
      { id: 'a', burnBal: 2, actCount: 10 },
      { id: 'b', burnBal: 1, actCount: 10 },
    ];
    const { x } = solveStanding(ledgers, [], { tilt: 1 });
    close(x[0]!, 2.0, 1e-10);
    close(x[1]!, 1.0, 1e-10);
  });

  it('dangling recipient resolves to the author diagonal (universal act weighing)', () => {
    const base = baseScoreMatrix(['a', 'b'], [
      { src: 'a', rcp: 'ghost', coeff: 0.5 },
      { src: 'a', rcp: 'b', coeff: 1.0 },
    ]);
    // row a: κ_self 1 + 0.5 self-resolved = 1.5 diagonal, 1.0 outward → share 0.4
    expect(base[0]![0]).toBeCloseTo(1.5, 12);
    expect(base[0]![1]).toBeCloseTo(1.0, 12);
  });

  it('artifact crowding: self-resolved coefficient shrinks outward shares', () => {
    const ledgers = [
      { id: 'a', burnBal: 1, actCount: 5 },
      { id: 'b', burnBal: 2, actCount: 5 },
    ];
    const bare = solveStanding(ledgers, [{ src: 'a', rcp: 'b', coeff: 1 }], { tilt: 1 });
    const loaded = solveStanding(ledgers, [
      { src: 'a', rcp: 'b', coeff: 1 },
      { src: 'a', rcp: 'a', coeff: 3 },
    ], { tilt: 1 });
    // more self-resolved mass ⇒ a keeps more of itself ⇒ b receives less of a's
    // lower rate ⇒ b's standing rises toward its own rate
    expect(loaded.pi[0]![1]!).toBeLessThan(bare.pi[0]![1]!);
    expect(loaded.x[1]!).toBeGreaterThan(bare.x[1]!);
  });

  it('pair-mass conservation: transported sums equal raw sums', () => {
    const { pi } = solveStanding(REFERENCE_EPOCH.ledgers, REFERENCE_EPOCH.cells, { tilt: 1 });
    const burns = REFERENCE_EPOCH.ledgers.map((l) => l.burnBal);
    const counts = REFERENCE_EPOCH.ledgers.map((l) => l.actCount);
    let tb = 0;
    let tn = 0;
    for (let i = 0; i < burns.length; i++) {
      for (let u = 0; u < burns.length; u++) {
        tb += pi[u]![i]! * burns[u]!;
        tn += pi[u]![i]! * counts[u]!;
      }
    }
    close(tb, burns.reduce((a, b) => a + b, 0), 1e-9);
    close(tn, counts.reduce((a, b) => a + b, 0), 1e-9);
  });
});
