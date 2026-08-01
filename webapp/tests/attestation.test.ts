import { describe, it, expect } from 'vitest';
import { AttestationLedger, OPERATOR } from '../src/engine/attestation';

const close = (actual: number, expected: number, tol = 1e-9) =>
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(tol);

describe('Layer 0: genesis and floor', () => {
  it('genesis state (post:model:genesis)', () => {
    const l = new AttestationLedger({ E0: 100, zeta: 0.5 });
    close(l.omega, 100);
    close(l.yLive, 50);
    close(l.yLock, 50);
    close(l.floor(), 1);
    close(l.bal(OPERATOR).live, 50);
    close(l.bal(OPERATOR).tlock, 50);
  });

  it('supply conservation Y = Y_L + Y_T across maturity conversion', () => {
    const l = new AttestationLedger({ maturityCycle: 2 });
    const before = l.totalSupply;
    l.closeCycle();
    l.closeCycle(); // k_m reached: relabel
    close(l.totalSupply, before);
    close(l.yLock, 0);
    close(l.bal(OPERATOR).tlock, 0);
  });
});

describe('Layer 0: burn (the attestation producer)', () => {
  it('burn credits A at the settled floor and raises the live floor', () => {
    const l = new AttestationLedger({ E0: 100, zeta: 0.5 });
    const phiBefore = l.floor();
    const dA = l.burn(OPERATOR, 10);
    close(dA, 10 * 1); // settled floor = genesis 1
    close(l.bal(OPERATOR).attest, 10);
    expect(l.floor()).toBeGreaterThan(phiBefore); // Ω unchanged, Y down
    close(l.floor(), 100 / 90);
  });

  it('settlement-pinned: intra-cycle burns all credit at the same committed floor', () => {
    const l = new AttestationLedger({ E0: 100, zeta: 0.5 });
    const a1 = l.burn(OPERATOR, 10);
    const a2 = l.burn(OPERATOR, 10); // floor rose live, but credit is pinned
    close(a1, a2);
    l.closeCycle(); // settlement commits the new floor
    const a3 = l.burn(OPERATOR, 10);
    expect(a3).toBeGreaterThan(a2); // now credited at the higher committed floor
  });

  it('bootstrap capacity: total attestation before deposits stays under A_max = E0·ln(1/(1−ζ))', () => {
    const l = new AttestationLedger({ E0: 100, zeta: 0.5, maturityCycle: 1e9 });
    // arbitrarily fine interleaving approaches the sup from below
    let total = 0;
    for (let i = 0; i < 5000 && l.bal(OPERATOR).live > 1e-6; i++) {
      total += l.burn(OPERATOR, Math.min(0.01, l.bal(OPERATOR).live));
      l.closeCycle();
    }
    const cap = l.attestCap; // 100·ln 2 ≈ 69.31
    close(cap, 100 * Math.log(2), 1e-9);
    expect(total).toBeLessThan(cap);
    expect(total).toBeGreaterThan(cap * 0.99); // the bound is tight
  });
});

describe('Layer 0: floor invariants', () => {
  it('redemption preserves the floor', () => {
    const l = new AttestationLedger({ E0: 100, zeta: 0.5 });
    const phi = l.floor();
    const payout = l.redeem(OPERATOR, 10);
    close(payout, 10 * phi);
    close(l.floor(), phi, 1e-12);
  });

  it('issuance preserves the floor (ΔY = ΔΩ/φ⁻)', () => {
    const l = new AttestationLedger({ E0: 100, zeta: 0.5 });
    l.burn(OPERATOR, 20); // raise the floor first
    const phi = l.floor();
    l.faucet('u1', 50);
    l.deposit('u1', 50);
    l.closeCycle();
    close(l.floor(), phi, 1e-12);
  });

  it('floor never decreases across mixed operation sequences', () => {
    const l = new AttestationLedger({ E0: 100, zeta: 0.5, maturityCycle: 3 });
    let phi = l.floor();
    const check = () => {
      expect(l.floor()).toBeGreaterThanOrEqual(phi - 1e-12);
      phi = l.floor();
    };
    l.faucet('u1', 40);
    l.deposit('u1', 25); check();
    l.closeCycle(); check();
    l.burn(OPERATOR, 5); check();
    l.redeem(OPERATOR, 5); check();
    l.deposit('u1', 15); check();
    l.closeCycle(); check();
    l.closeCycle(); check(); // maturity conversion
    l.burn('u1', 1); check();
  });
});

describe('Layer 0: cycle mint with fee and split', () => {
  it('depositor gets (1−f) at ζ:(1−ζ) during bootstrapping; operator gets the fee', () => {
    const l = new AttestationLedger({ E0: 100, zeta: 0.5, fee: 0.5, maturityCycle: 10 });
    l.faucet('u1', 40);
    l.deposit('u1', 40);
    const opLiveBefore = l.bal(OPERATOR).live;
    const { minted } = l.closeCycle();
    close(minted, 40); // φ⁻ = 1
    const u1 = l.bal('u1');
    close(u1.live, 0.5 * 0.5 * 40);  // (1−f)·ζ·ΔY = 10
    close(u1.tlock, 0.5 * 0.5 * 40); // (1−f)·(1−ζ)·ΔY = 10
    close(l.bal(OPERATOR).live - opLiveBefore, 0.5 * 0.5 * 40);
    // net live share (1−f)ζ = 0.25 → attestation unit cost 1/((1−f)ζ) = 4 reserve
    const dA = l.burn('u1', u1.live);
    close(40 / dA, 4, 0.05); // ≈ the cost projection at φ≈1
  });

  it('normal phase mints all-live', () => {
    const l = new AttestationLedger({ E0: 100, zeta: 0.5, fee: 0.5, maturityCycle: 1 });
    l.closeCycle(); // now in normal phase
    l.faucet('u1', 20);
    l.deposit('u1', 20);
    l.closeCycle();
    const u1 = l.bal('u1');
    close(u1.tlock, 0);
    expect(u1.live).toBeGreaterThan(0);
  });

  it('transfer moves units but touches no Ω, φ, or A', () => {
    const l = new AttestationLedger({ E0: 100, zeta: 0.5 });
    const phi = l.floor();
    const omega = l.omega;
    l.transfer(OPERATOR, 'u2', 5, 'live');
    close(l.bal('u2').live, 5);
    close(l.floor(), phi, 1e-15);
    close(l.omega, omega, 1e-15);
    close(l.bal('u2').attest, 0);
  });
});
