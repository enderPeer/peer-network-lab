import { DOMAIN_MASKS, type Domain, type Mask, type Tier, type Mat3, type Mat2 } from './tensor';
import { sentimentSlice, pathView, frobenius, detScore, detSign, dampedWeight } from './tensor';
import { FAMILIES } from './families';

export type NodeKind =
  | 'Actor'
  | 'Profile'
  | 'Content'
  | 'Comment'
  | 'Type'
  | 'Item'
  | 'Chat'
  | 'Offer'
  | 'Message';

export interface NodeInfo {
  id: string;
  kind: NodeKind;
  label: string;
}

export interface EdgeInput {
  id: string;
  family: string;
  src: string;
  tgt: string;
  pd: number;
  pi: number;
  /** Override the family's domain/tier (used by promoted-mask special cases). */
  domain?: Domain;
  tier?: Tier;
  /** Fix τ instead of deriving it from pre-degrees (derived Self-edges use tenure τ). */
  tauOverride?: number;
}

export interface EdgeRecord {
  id: string;
  family: string;
  src: string;
  tgt: string;
  pd: number;
  pi: number;
  domain: Domain;
  mask: Mask;
  tier: Tier;
  tau: number;
  slice: Mat3;
  pv: Mat2;
  frob: number;
  score: number;
  sign: number;
  weight: number;
  appendIndex: number;
}

function resolveMask(family: string, domain: Domain): Mask {
  const spec = FAMILIES[family];
  if (spec?.promoted) return DOMAIN_MASKS.Tribal; // promotion = full (1,1,1,1) stored mask
  return DOMAIN_MASKS[domain];
}

/**
 * Append-only projected raw graph with authoritative-replay maturity:
 * τ_e = 1 − 1/(1 + max(preDeg(src), preDeg(tgt))), where pre-degrees count
 * endpoint incidence strictly before the parent act. Both legs of a hyper
 * act read the same pre-act state and do not mature each other.
 */
export class RawGraph {
  nodes = new Map<string, NodeInfo>();
  edges: EdgeRecord[] = [];
  private preDeg = new Map<string, number>();

  addNode(node: NodeInfo): this {
    this.nodes.set(node.id, node);
    return this;
  }

  degree(nodeId: string): number {
    return this.preDeg.get(nodeId) ?? 0;
  }

  private buildRecord(input: EdgeInput, tau: number): EdgeRecord {
    const spec = FAMILIES[input.family];
    const domain = input.domain ?? spec?.domain ?? 'Tribal';
    const tier = input.tier ?? spec?.tier ?? 'full';
    const mask = resolveMask(input.family, domain);
    const slice = sentimentSlice(input.pd, input.pi, mask);
    const pv = pathView(input.pd, input.pi, mask, tier);
    const score = detScore(pv);
    const sign = spec?.signForced ? 1 : detSign(pv);
    return {
      id: input.id,
      family: input.family,
      src: input.src,
      tgt: input.tgt,
      pd: input.pd,
      pi: input.pi,
      domain,
      mask,
      tier,
      tau,
      slice,
      pv,
      frob: frobenius(slice),
      score,
      sign,
      weight: dampedWeight(score, tau),
      appendIndex: this.edges.length,
    };
  }

  private bump(nodeId: string, by = 1): void {
    this.preDeg.set(nodeId, (this.preDeg.get(nodeId) ?? 0) + by);
  }

  /** Append a binary act (one edge projection). */
  append(input: EdgeInput): EdgeRecord {
    const tau =
      input.tauOverride ??
      1 - 1 / (1 + Math.max(this.degree(input.src), this.degree(input.tgt)));
    const rec = this.buildRecord(input, tau);
    this.edges.push(rec);
    this.bump(input.src);
    this.bump(input.tgt);
    return rec;
  }

  /** Append a hyper act: both legs see the same pre-act state, one act time. */
  appendHyper(aLeg: EdgeInput, tLeg: EdgeInput): [EdgeRecord, EdgeRecord] {
    const tauA =
      aLeg.tauOverride ??
      1 - 1 / (1 + Math.max(this.degree(aLeg.src), this.degree(aLeg.tgt)));
    const tauT =
      tLeg.tauOverride ??
      1 - 1 / (1 + Math.max(this.degree(tLeg.src), this.degree(tLeg.tgt)));
    const recA = this.buildRecord(aLeg, tauA);
    this.edges.push(recA);
    const recT = this.buildRecord(tLeg, tauT);
    this.edges.push(recT);
    this.bump(aLeg.src);
    this.bump(aLeg.tgt);
    this.bump(tLeg.src);
    this.bump(tLeg.tgt);
    return [recA, recT];
  }

  outgoing(nodeId: string): EdgeRecord[] {
    return this.edges.filter((e) => e.src === nodeId);
  }

  incoming(nodeId: string): EdgeRecord[] {
    return this.edges.filter((e) => e.tgt === nodeId);
  }
}
