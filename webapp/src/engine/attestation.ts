/**
 * Peer Attestation — Layer 0 of the stack (spec PeerAttestation v0.6.0).
 * A full-reserve, two-class, conserved, burnable reserve receipt whose sole
 * computational export is the attestation map A : 𝔸 → ℝ≥0.
 *
 * State: (Ω reserve pool, Y_L live supply, Y_T time-locked supply, {A_a}, Q escrow)
 * Floor: φ = Ω / (Y_L + Y_T) — ratchets up only (thm:invariants:floor-non-decrease).
 *
 * Operations (def:operations:*):
 *  - deposit(δ; a): escrow only; the receipt mints at the next cycle boundary.
 *  - burn(x; a): destroy x live units; A_a += x·φ_settled (settlement-pinned:
 *    credited at the floor committed by the most recent preceding settlement
 *    event — this realization designates cycle boundaries as settlement events).
 *    Ω unchanged ⇒ the floor rises. Consent-free, irreversible.
 *  - redeem(x): return x live units for x·φ reserve — floor-preserving.
 *  - transfer: class-internal, touches no Ω/Y/A.
 *  - cycle processing (alg:operations:cycle-processing): mint ΔY = ΔΩ/φ⁻
 *    (floor-preserving issuance), fee f to the operator, ζ:(1−ζ) live:time-locked
 *    split during bootstrapping [0, k_m), all-live in the normal phase;
 *    maturity conversion relabels Y_T → Y_L once at k_m (value-neutral).
 *
 * Placeholders per rem:model:calibration: ζ = f = 0.5 (roles are normative,
 * magnitudes are calibration outputs). Bootstrap capacity: A_max = E₀·ln(1/(1−ζ)).
 *
 * Layer-1 seam: the consumer reads A_a as burn_val — every attestation
 * increment returned by burn() feeds the L1 ledger's residual balance.
 */

export interface L0Config {
  /** Genesis reserve E₀ (Ω(0) = Y(0) = E₀, φ(0) = 1). */
  E0: number;
  /** Live split ζ ∈ (0,1) at mint during bootstrapping. */
  zeta: number;
  /** Mint fee rate f ∈ (0,1), to the operator. */
  fee: number;
  /** Maturity-conversion cycle k_m (announced; bootstrapping = [0, k_m)). */
  maturityCycle: number;
}

export const L0_DEFAULTS: L0Config = { E0: 100, zeta: 0.5, fee: 0.5, maturityCycle: 10 };

export interface L0Balance {
  /** External reserve units held (sandbox wallet outside the pool). */
  reserve: number;
  /** Live-class receipt units. */
  live: number;
  /** Time-locked-class receipt units. */
  tlock: number;
  /** Attestation A_a — cumulative reserve-value destroyed. THE export. */
  attest: number;
}

export const OPERATOR = 'op';

export class AttestationLedger {
  cfg: L0Config;
  omega: number;
  yLive = 0;
  yLock = 0;
  cycle = 0;
  /** Floor committed by the most recent settlement event (genesis: 1). */
  settledFloor = 1;
  escrow: { addr: string; amount: number }[] = [];
  balances = new Map<string, L0Balance>();

  constructor(cfg: Partial<L0Config> = {}) {
    this.cfg = { ...L0_DEFAULTS, ...cfg };
    const { E0, zeta } = this.cfg;
    // Genesis (post:model:genesis): the operator is the genesis depositor.
    this.omega = E0;
    this.yLive = zeta * E0;
    this.yLock = (1 - zeta) * E0;
    const op = this.bal(OPERATOR);
    op.live = this.yLive;
    op.tlock = this.yLock;
  }

  bal(addr: string): L0Balance {
    let b = this.balances.get(addr);
    if (!b) {
      b = { reserve: 0, live: 0, tlock: 0, attest: 0 };
      this.balances.set(addr, b);
    }
    return b;
  }

  get totalSupply(): number {
    return this.yLive + this.yLock;
  }

  /** Redemption-rate floor φ = Ω/Y (current, not the settled one). */
  floor(): number {
    return this.totalSupply > 0 ? this.omega / this.totalSupply : 1;
  }

  get bootstrapping(): boolean {
    return this.cycle < this.cfg.maturityCycle;
  }

  /** Bootstrap capacity bound A_max = E₀·ln(1/(1−ζ)) (prop:interface:bootstrap-capacity). */
  get attestCap(): number {
    return this.cfg.E0 * Math.log(1 / (1 - this.cfg.zeta));
  }

  /** Sandbox faucet: external reserve into an address's wallet (deployment concern). */
  faucet(addr: string, amount: number): void {
    this.bal(addr).reserve += amount;
  }

  /** deposit(δ; a): reserve escrows now, mints at the next cycle boundary. */
  deposit(addr: string, delta: number): void {
    const b = this.bal(addr);
    if (delta <= 0 || b.reserve < delta - 1e-12) throw new Error('insufficient reserve');
    b.reserve -= delta;
    this.escrow.push({ addr, amount: delta });
  }

  /**
   * burn(x; a): destroy own live units in favor of `favor` (default self).
   * Returns the attestation increment δ_A = x·φ_settled.
   */
  burn(addr: string, x: number, favor = addr): number {
    const b = this.bal(addr);
    if (x <= 0 || b.live < x - 1e-12) throw new Error('insufficient live units');
    b.live -= x;
    this.yLive -= x;
    const deltaA = x * this.settledFloor; // settlement-pinned valuation
    this.bal(favor).attest += deltaA;
    return deltaA; // Ω unchanged ⇒ φ strictly rises
  }

  /** redeem(x): live units back to reserve at the current floor — floor-preserving. */
  redeem(addr: string, x: number): number {
    const b = this.bal(addr);
    if (x <= 0 || b.live < x - 1e-12) throw new Error('insufficient live units');
    const payout = x * this.floor();
    b.live -= x;
    this.yLive -= x;
    this.omega -= payout;
    b.reserve += payout;
    return payout;
  }

  /** Class-internal transfer; no Ω, Y, φ, or A change. */
  transfer(from: string, to: string, x: number, cls: 'live' | 'tlock' = 'live'): void {
    const f = this.bal(from);
    if (x <= 0 || f[cls] < x - 1e-12) throw new Error('insufficient units');
    f[cls] -= x;
    this.bal(to)[cls] += x;
  }

  /**
   * Cycle Receipt Processing (alg:operations:cycle-processing) + maturity
   * conversion at k_m. Also commits the new settled floor (cycle boundaries
   * are this realization's designated settlement events).
   */
  closeCycle(): { minted: number; floor: number } {
    const preFloor = this.floor(); // A.0 — pre-issuance floor φ⁻
    const dOmega = this.escrow.reduce((s, e) => s + e.amount, 0); // A.1
    const boot = this.cycle + 1 < this.cfg.maturityCycle;
    let minted = 0;
    if (dOmega > 0) {
      const dY = dOmega / preFloor; // A.2 — floor-preserving issuance
      minted = dY;
      const { fee, zeta } = this.cfg;
      for (const e of this.escrow) {
        const share = (1 - fee) * (e.amount / dOmega) * dY;
        const b = this.bal(e.addr);
        if (boot) {
          b.live += share * zeta;
          b.tlock += share * (1 - zeta);
        } else {
          b.live += share;
        }
      }
      const op = this.bal(OPERATOR);
      if (boot) {
        op.live += fee * zeta * dY;
        op.tlock += fee * (1 - zeta) * dY;
        this.yLive += zeta * dY;
        this.yLock += (1 - zeta) * dY;
      } else {
        op.live += fee * dY;
        this.yLive += dY;
      }
      this.omega += dOmega; // A.3
      this.escrow = [];
    }
    this.cycle += 1;
    if (this.cycle === this.cfg.maturityCycle) {
      // A.3½ — maturity conversion: one value-neutral relabel, Y unchanged.
      for (const b of this.balances.values()) {
        b.live += b.tlock;
        b.tlock = 0;
      }
      this.yLive += this.yLock;
      this.yLock = 0;
    }
    this.settledFloor = this.floor(); // settlement event commits the floor
    return { minted, floor: this.settledFloor };
  }
}
