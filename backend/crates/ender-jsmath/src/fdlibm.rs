//! Faithful Rust translation of V8's fdlibm-derived transcendentals
//! (src/base/ieee754.cc at tag 12.4.254.21 — the V8 inside the Node that
//! recorded the parity vectors): exp, log, expm1, tanh, pow, scalbn.
//!
//! Every named constant is built with from_bits from the bit pattern the C
//! source documents, so no decimal-parsing step sits between this file and
//! fdlibm. Integer arithmetic uses wrapping ops where the C relied on
//! two's-complement wraparound. The 19k recorded vectors are the proof.
#![allow(clippy::excessive_precision)]

#[inline]
fn hi_word(x: f64) -> u32 {
    (x.to_bits() >> 32) as u32
}

#[inline]
fn lo_word(x: f64) -> u32 {
    x.to_bits() as u32
}

#[inline]
fn from_words(hi: u32, lo: u32) -> f64 {
    f64::from_bits(((hi as u64) << 32) | lo as u64)
}

#[inline]
fn set_hi(x: f64, hi: u32) -> f64 {
    f64::from_bits((x.to_bits() & 0x0000_0000_FFFF_FFFF) | ((hi as u64) << 32))
}

#[inline]
fn set_lo(x: f64, lo: u32) -> f64 {
    f64::from_bits((x.to_bits() & 0xFFFF_FFFF_0000_0000) | lo as u64)
}

const HUGE: f64 = 1.0e300;
const TINY: f64 = 1.0e-300;
/// The exact bit pattern V8's ieee754.cc produces via
/// std::numeric_limits<double>::signaling_NaN() — the vectors compare bits,
/// so NaN identity matters here even though canonical() refuses NaN anyway.
const SIGNALING_NAN: f64 = f64::from_bits(0x7FF0_0000_0000_0001);

/// fdlibm s_scalbn: x * 2^n without computing 2^n.
pub fn scalbn(mut x: f64, n: i32) -> f64 {
    let two54 = f64::from_bits(0x4350_0000_0000_0000);
    let twom54 = f64::from_bits(0x3C90_0000_0000_0000);
    let mut hx = hi_word(x) as i32;
    let lx = lo_word(x);
    let mut k = (hx & 0x7FF0_0000) >> 20;
    if k == 0 {
        // 0 or subnormal
        if ((hx & 0x7FFF_FFFF) as u32 | lx) == 0 {
            return x;
        }
        x *= two54;
        hx = hi_word(x) as i32;
        k = ((hx & 0x7FF0_0000) >> 20) - 54;
        if n < -50000 {
            return TINY * x;
        }
    }
    if k == 0x7FF {
        return x + x; // NaN or Inf
    }
    k += n;
    if k > 0x7FE {
        return HUGE * (if x < 0.0 { -HUGE } else { HUGE });
    }
    if k > 0 {
        return set_hi(x, ((hx as u32) & 0x800F_FFFF) | ((k as u32) << 20));
    }
    if k <= -54 {
        return if n > 50000 {
            HUGE * (if x < 0.0 { -HUGE } else { HUGE })
        } else {
            TINY * (if x < 0.0 { -TINY } else { TINY })
        };
    }
    k += 54;
    x = set_hi(x, ((hx as u32) & 0x800F_FFFF) | ((k as u32) << 20));
    x * twom54
}

/// fdlibm/V8 exp — including V8's exp(1) == E special case.
pub fn exp(mut x: f64) -> f64 {
    let half = [0.5f64, -0.5];
    let o_threshold = f64::from_bits(0x4086_2E42_FEFA_39EF);
    let u_threshold = f64::from_bits(0xC087_4910_D52D_3051);
    let ln2_hi = [
        f64::from_bits(0x3FE6_2E42_FEE0_0000),
        f64::from_bits(0xBFE6_2E42_FEE0_0000),
    ];
    let ln2_lo = [
        f64::from_bits(0x3DEA_39EF_3579_3C76),
        f64::from_bits(0xBDEA_39EF_3579_3C76),
    ];
    let invln2 = f64::from_bits(0x3FF7_1547_652B_82FE);
    let p1 = f64::from_bits(0x3FC5_5555_5555_553E);
    let p2 = f64::from_bits(0xBF66_C16C_16BE_BD93);
    let p3 = f64::from_bits(0x3F11_566A_AF25_DE2C);
    let p4 = f64::from_bits(0xBEBB_BD41_C5D2_6BF1);
    let p5 = f64::from_bits(0x3E66_3769_72BE_A4D0);
    let e_const = f64::from_bits(0x4005_BF0A_8B14_5769);
    let twom1000 = f64::from_bits(0x0170_0000_0000_0000);
    let two1023 = f64::from_bits(0x7FE0_0000_0000_0000);

    let mut hi = 0.0f64;
    let mut lo = 0.0f64;
    let mut k: i32 = 0;
    let mut hx = hi_word(x);
    let xsb = ((hx >> 31) & 1) as usize;
    hx &= 0x7FFF_FFFF;

    if hx >= 0x4086_2E42 {
        // |x| >= 709.78...
        if hx >= 0x7FF0_0000 {
            let lx = lo_word(x);
            if ((hx & 0xF_FFFF) | lx) != 0 {
                return x + x; // NaN
            }
            return if xsb == 0 { x } else { 0.0 }; // exp(±inf)
        }
        if x > o_threshold {
            return HUGE * HUGE;
        }
        if x < u_threshold {
            return twom1000 * twom1000;
        }
    }

    if hx > 0x3FD6_2E42 {
        // |x| > 0.5 ln2
        if hx < 0x3FF0_A2B2 {
            // and |x| < 1.5 ln2
            if x == 1.0 {
                return e_const;
            }
            hi = x - ln2_hi[xsb];
            lo = ln2_lo[xsb];
            k = 1 - xsb as i32 - xsb as i32;
        } else {
            k = (invln2 * x + half[xsb]) as i32;
            let t = k as f64;
            hi = x - t * ln2_hi[0]; // t*ln2HI is exact here
            lo = t * ln2_lo[0];
        }
        x = hi - lo;
    } else if hx < 0x3E30_0000 {
        // |x| < 2^-28
        if HUGE + x > 1.0 {
            return 1.0 + x;
        }
    } else {
        k = 0;
    }

    let t = x * x;
    let twopk = if k >= -1021 {
        from_words(0x3FF0_0000u32.wrapping_add((k as u32) << 20), 0)
    } else {
        from_words(0x3FF0_0000u32.wrapping_add(((k + 1000) as u32) << 20), 0)
    };
    let c = x - t * (p1 + t * (p2 + t * (p3 + t * (p4 + t * p5))));
    if k == 0 {
        return 1.0 - ((x * c) / (c - 2.0) - x);
    }
    let y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
    if k >= -1021 {
        if k == 1024 {
            return y * 2.0 * two1023;
        }
        y * twopk
    } else {
        y * twopk * twom1000
    }
}

/// fdlibm/V8 log.
pub fn log(mut x: f64) -> f64 {
    let ln2_hi = f64::from_bits(0x3FE6_2E42_FEE0_0000);
    let ln2_lo = f64::from_bits(0x3DEA_39EF_3579_3C76);
    let two54 = f64::from_bits(0x4350_0000_0000_0000);
    let lg1 = f64::from_bits(0x3FE5_5555_5555_5593);
    let lg2 = f64::from_bits(0x3FD9_9999_9997_FA04);
    let lg3 = f64::from_bits(0x3FD2_4924_9422_9359);
    let lg4 = f64::from_bits(0x3FCC_71C5_1D8E_78AF);
    let lg5 = f64::from_bits(0x3FC7_4664_96CB_03DE);
    let lg6 = f64::from_bits(0x3FC3_9A09_D078_C69F);
    let lg7 = f64::from_bits(0x3FC2_F112_DF3E_5244);

    let mut hx = hi_word(x) as i32;
    let lx = lo_word(x);

    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        // x < 2^-1022
        if ((hx & 0x7FFF_FFFF) as u32 | lx) == 0 {
            return f64::NEG_INFINITY; // log(±0)
        }
        if hx < 0 {
            return f64::NAN; // log(negative)
        }
        k -= 54;
        x *= two54;
        hx = hi_word(x) as i32;
    }
    if hx >= 0x7FF0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000F_FFFF;
    let i = (hx + 0x95F64) & 0x10_0000;
    x = set_hi(x, (hx | (i ^ 0x3FF0_0000)) as u32); // normalize x or x/2
    k += i >> 20;
    let f = x - 1.0;
    if (0x000F_FFFF & (2 + hx)) < 3 {
        // -2^-20 <= f < 2^-20
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            let dk = k as f64;
            return dk * ln2_hi + dk * ln2_lo;
        }
        let r = f * f * (0.5 - 0.33333333333333333 * f);
        if k == 0 {
            return f - r;
        }
        let dk = k as f64;
        return dk * ln2_hi - ((r - dk * ln2_lo) - f);
    }
    let s = f / (2.0 + f);
    let dk = k as f64;
    let z = s * s;
    let mut i = hx - 0x6147A;
    let w = z * z;
    let j = 0x6B851 - hx;
    let t1 = w * (lg2 + w * (lg4 + w * lg6));
    let t2 = z * (lg1 + w * (lg3 + w * (lg5 + w * lg7)));
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (hfsq - s * (hfsq + r))
        } else {
            dk * ln2_hi - ((hfsq - (s * (hfsq + r) + dk * ln2_lo)) - f)
        }
    } else if k == 0 {
        f - s * (f - r)
    } else {
        dk * ln2_hi - ((s * (f - r) - dk * ln2_lo) - f)
    }
}

/// fdlibm/V8 expm1.
pub fn expm1(mut x: f64) -> f64 {
    let o_threshold = f64::from_bits(0x4086_2E42_FEFA_39EF);
    let ln2_hi = f64::from_bits(0x3FE6_2E42_FEE0_0000);
    let ln2_lo = f64::from_bits(0x3DEA_39EF_3579_3C76);
    let invln2 = f64::from_bits(0x3FF7_1547_652B_82FE);
    let q1 = f64::from_bits(0xBFA1_1111_1111_10F4);
    let q2 = f64::from_bits(0x3F5A_01A0_19FE_5585);
    let q3 = f64::from_bits(0xBF14_CE19_9EAA_DBB7);
    let q4 = f64::from_bits(0x3ED0_CFCA_86E6_5239);
    let q5 = f64::from_bits(0xBE8A_FDB7_6E09_C32D);
    let two1023 = f64::from_bits(0x7FE0_0000_0000_0000);

    let mut hx = hi_word(x);
    let xsb = hx & 0x8000_0000;
    hx &= 0x7FFF_FFFF;

    if hx >= 0x4043_687A {
        // |x| >= 56 ln2
        if hx >= 0x4086_2E42 {
            if hx >= 0x7FF0_0000 {
                let low = lo_word(x);
                if ((hx & 0xF_FFFF) | low) != 0 {
                    return x + x; // NaN
                }
                return if xsb == 0 { x } else { -1.0 };
            }
            if x > o_threshold {
                return HUGE * HUGE;
            }
        }
        if xsb != 0 {
            // x < -56 ln2
            if x + TINY < 0.0 {
                return TINY - 1.0;
            }
        }
    }

    let mut k: i32;
    let mut c = 0.0f64;
    if hx > 0x3FD6_2E42 {
        // |x| > 0.5 ln2
        let (hi, lo) = if hx < 0x3FF0_A2B2 {
            // and |x| < 1.5 ln2
            if xsb == 0 {
                k = 1;
                (x - ln2_hi, ln2_lo)
            } else {
                k = -1;
                (x + ln2_hi, -ln2_lo)
            }
        } else {
            k = (invln2 * x + if xsb == 0 { 0.5 } else { -0.5 }) as i32;
            let t = k as f64;
            (x - t * ln2_hi, t * ln2_lo)
        };
        x = hi - lo;
        c = (hi - x) - lo;
    } else if hx < 0x3C90_0000 {
        // |x| < 2^-54
        let t = HUGE + x;
        return x - (t - (HUGE + x));
    } else {
        k = 0;
    }

    let hfx = 0.5 * x;
    let hxs = x * hfx;
    let r1 = 1.0 + hxs * (q1 + hxs * (q2 + hxs * (q3 + hxs * (q4 + hxs * q5))));
    let t = 3.0 - r1 * hfx;
    let mut e = hxs * ((r1 - t) / (6.0 - x * t));
    if k == 0 {
        return x - (x * e - hxs); // c is 0
    }
    let twopk = from_words(0x3FF0_0000u32.wrapping_add((k as u32) << 20), 0);
    e = x * (e - c) - c;
    e -= hxs;
    if k == -1 {
        return 0.5 * (x - e) - 0.5;
    }
    if k == 1 {
        return if x < -0.25 {
            -2.0 * (e - (x + 0.5))
        } else {
            1.0 + 2.0 * (x - e)
        };
    }
    if k <= -2 || k > 56 {
        let mut y = 1.0 - (e - x);
        if k == 1024 {
            y = y * 2.0 * two1023;
        } else {
            y *= twopk;
        }
        return y - 1.0;
    }
    let y = if k < 20 {
        let t = set_hi(1.0, 0x3FF0_0000 - (0x20_0000 >> k) as u32); // t = 1 - 2^-k
        (t - (e - x)) * twopk
    } else {
        let t = set_hi(0.0, (((0x3FF - k) as u32) << 20) & 0xFFFF_FFFF); // 2^-k
        let mut y = x - (e + t);
        y += 1.0;
        y * twopk
    };
    y
}

/// fdlibm/V8 tanh.
pub fn tanh(x: f64) -> f64 {
    let jx = hi_word(x) as i32;
    let ix = jx & 0x7FFF_FFFF;

    if ix >= 0x7FF0_0000 {
        return if jx >= 0 {
            1.0 / x + 1.0 // tanh(±inf) = ±1
        } else {
            1.0 / x - 1.0 // tanh(NaN) = NaN
        };
    }

    let z = if ix < 0x4036_0000 {
        // |x| < 22
        if ix < 0x3E30_0000 {
            // |x| < 2^-28
            if HUGE + x > 1.0 {
                return x;
            }
        }
        if ix >= 0x3FF0_0000 {
            // |x| >= 1
            let t = expm1(2.0 * x.abs());
            1.0 - 2.0 / (t + 2.0)
        } else {
            let t = expm1(-2.0 * x.abs());
            -t / (t + 2.0)
        }
    } else {
        1.0 - TINY // |x| >= 22
    };
    if jx >= 0 {
        z
    } else {
        -z
    }
}

/// fdlibm/V8 pow.
pub fn pow(x: f64, y: f64) -> f64 {
    let bp = [1.0f64, 1.5];
    let dp_h = [0.0f64, f64::from_bits(0x3FE2_B803_4000_0000)];
    let dp_l = [0.0f64, f64::from_bits(0x3E4C_FDEB_43CF_D006)];
    let two53 = f64::from_bits(0x4340_0000_0000_0000);
    let l1 = f64::from_bits(0x3FE3_3333_3333_3303);
    let l2 = f64::from_bits(0x3FDB_6DB6_DB6F_ABFF);
    let l3 = f64::from_bits(0x3FD5_5555_518F_264D);
    let l4 = f64::from_bits(0x3FD1_7460_A91D_4101);
    let l5 = f64::from_bits(0x3FCD_864A_93C9_DB65);
    let l6 = f64::from_bits(0x3FCA_7E28_4A45_4EEF);
    let p1 = f64::from_bits(0x3FC5_5555_5555_553E);
    let p2 = f64::from_bits(0xBF66_C16C_16BE_BD93);
    let p3 = f64::from_bits(0x3F11_566A_AF25_DE2C);
    let p4 = f64::from_bits(0xBEBB_BD41_C5D2_6BF1);
    let p5 = f64::from_bits(0x3E66_3769_72BE_A4D0);
    let lg2 = f64::from_bits(0x3FE6_2E42_FEFA_39EF);
    let lg2_h = f64::from_bits(0x3FE6_2E43_0000_0000);
    let lg2_l = f64::from_bits(0xBE20_5C61_0CA8_6C39);
    let ovt = 8.0085662595372944372e-17;
    let cp = f64::from_bits(0x3FEE_C709_DC3A_03FD);
    let cp_h = f64::from_bits(0x3FEE_C709_E000_0000);
    let cp_l = f64::from_bits(0xBE3E_2FE0_145B_01F5);
    let ivln2 = f64::from_bits(0x3FF7_1547_652B_82FE);
    let ivln2_h = f64::from_bits(0x3FF7_1547_6000_0000);
    let ivln2_l = f64::from_bits(0x3E54_AE0B_F85D_DF44);

    let hx = hi_word(x) as i32;
    let lx = lo_word(x);
    let hy = hi_word(y) as i32;
    let ly = lo_word(y);
    let mut ix = hx & 0x7FFF_FFFF;
    let iy = hy & 0x7FFF_FFFF;

    // y == 0: x**0 = 1
    if (iy as u32 | ly) == 0 {
        return 1.0;
    }

    // NaN in either argument
    if ix > 0x7FF0_0000
        || (ix == 0x7FF0_0000 && lx != 0)
        || iy > 0x7FF0_0000
        || (iy == 0x7FF0_0000 && ly != 0)
    {
        return x + y;
    }

    // yisint: 0 non-integer, 1 odd, 2 even (only matters for x < 0)
    let mut yisint: i32 = 0;
    if hx < 0 {
        if iy >= 0x4340_0000 {
            yisint = 2;
        } else if iy >= 0x3FF0_0000 {
            let k = (iy >> 20) - 0x3FF;
            if k > 20 {
                let j = (ly >> (52 - k)) as i32;
                if (j.wrapping_shl((52 - k) as u32)) == ly as i32 {
                    yisint = 2 - (j & 1);
                }
            } else if ly == 0 {
                let j = iy >> (20 - k);
                if (j.wrapping_shl((20 - k) as u32)) == iy {
                    yisint = 2 - (j & 1);
                }
            }
        }
    }

    // special values of y
    if ly == 0 {
        if iy == 0x7FF0_0000 {
            // y is ±inf
            return if ((ix - 0x3FF0_0000) as u32 | lx) == 0 {
                y - y // (±1)**±inf is NaN
            } else if ix >= 0x3FF0_0000 {
                if hy >= 0 {
                    y
                } else {
                    0.0
                }
            } else if hy < 0 {
                -y
            } else {
                0.0
            };
        }
        if iy == 0x3FF0_0000 {
            // y is ±1
            return if hy < 0 { 1.0 / x } else { x };
        }
        if hy == 0x4000_0000 {
            return x * x; // y is 2
        }
        if hy == 0x3FE0_0000 && hx >= 0 {
            return x.sqrt(); // y is 0.5, x >= +0
        }
    }

    let mut ax = x.abs();
    // special values of x
    if lx == 0 && (ix == 0x7FF0_0000 || ix == 0 || ix == 0x3FF0_0000) {
        let mut z = ax; // x is ±0, ±inf, ±1
        if hy < 0 {
            z = 1.0 / z;
        }
        if hx < 0 {
            if ((ix - 0x3FF0_0000) as u32 | yisint as u32) == 0 {
                z = SIGNALING_NAN; // (-1)**non-int
            } else if yisint == 1 {
                z = -z;
            }
        }
        return z;
    }

    let n0 = (hx >> 31) + 1;

    // (x<0)**(non-int) is NaN
    if (n0 | yisint) == 0 {
        return SIGNALING_NAN;
    }

    let mut s = 1.0f64;
    if (n0 | (yisint - 1)) == 0 {
        s = -1.0; // (-ve)**(odd int)
    }

    let t1: f64;
    let t2: f64;
    if iy > 0x41E0_0000 {
        // |y| > 2^31
        if iy > 0x43F0_0000 {
            // |y| > 2^64: must over/underflow
            if ix <= 0x3FEF_FFFF {
                return if hy < 0 { HUGE * HUGE } else { TINY * TINY };
            }
            if ix >= 0x3FF0_0000 {
                return if hy > 0 { HUGE * HUGE } else { TINY * TINY };
            }
        }
        if ix < 0x3FEF_FFFF {
            return if hy < 0 { s * HUGE * HUGE } else { s * TINY * TINY };
        }
        if ix > 0x3FF0_0000 {
            return if hy > 0 { s * HUGE * HUGE } else { s * TINY * TINY };
        }
        // |1-x| tiny: log(x) by x - x^2/2 + x^3/3 - x^4/4
        let t = ax - 1.0;
        let w = (t * t) * (0.5 - t * (0.3333333333333333333333 - t * 0.25));
        let u = ivln2_h * t;
        let v = t * ivln2_l - w * ivln2;
        t1 = set_lo(u + v, 0);
        t2 = v - (t1 - u);
    } else {
        let mut n: i32 = 0;
        // subnormal x
        if ix < 0x0010_0000 {
            ax *= two53;
            n -= 53;
            ix = hi_word(ax) as i32;
        }
        n += (ix >> 20) - 0x3FF;
        let j = ix & 0x000F_FFFF;
        // determine interval
        ix = j | 0x3FF0_0000;
        let k: usize;
        if j <= 0x3988E {
            k = 0; // |x| < sqrt(3/2)
        } else if j < 0xBB67A {
            k = 1; // |x| < sqrt(3)
        } else {
            k = 0;
            n += 1;
            ix -= 0x0010_0000;
        }
        ax = set_hi(ax, ix as u32);

        // ss = s_h + s_l = (x-1)/(x+1) or (x-1.5)/(x+1.5)
        let u = ax - bp[k];
        let v = 1.0 / (ax + bp[k]);
        let ss = u * v;
        let s_h = set_lo(ss, 0);
        // t_h = ax + bp[k], high part
        let t_h = set_hi(
            0.0,
            (((ix >> 1) | 0x2000_0000) + 0x0008_0000 + ((k as i32) << 18)) as u32,
        );
        let t_l = ax - (t_h - bp[k]);
        let s_l = v * ((u - s_h * t_h) - s_h * t_l);
        // log(ax)
        let s2 = ss * ss;
        let mut r = s2 * s2 * (l1 + s2 * (l2 + s2 * (l3 + s2 * (l4 + s2 * (l5 + s2 * l6)))));
        r += s_l * (s_h + ss);
        let s2 = s_h * s_h;
        let t_h = set_lo(3.0 + s2 + r, 0);
        let t_l = r - ((t_h - 3.0) - s2);
        // u+v = ss*(1+...)
        let u = s_h * t_h;
        let v = s_l * t_h + t_l * ss;
        // 2/(3 log2) * (ss + ...)
        let p_h = set_lo(u + v, 0);
        let p_l = v - (p_h - u);
        let z_h = cp_h * p_h;
        let z_l = cp_l * p_h + p_l * cp + dp_l[k];
        // log2(ax) = (ss+..)*2/(3*log2) = n + dp_h + z_h + z_l
        let t = n as f64;
        t1 = set_lo(((z_h + z_l) + dp_h[k]) + t, 0);
        t2 = z_l - (((t1 - t) - dp_h[k]) - z_h);
    }

    // split y into y1 + y2, compute (y1+y2)*(t1+t2)
    let y1 = set_lo(y, 0);
    let mut p_l = (y - y1) * t1 + y * t2;
    let mut p_h = y1 * t1;
    let mut z = p_l + p_h;
    let j = hi_word(z) as i32;
    let i_low = lo_word(z);
    if j >= 0x4090_0000 {
        // z >= 1024
        if ((j - 0x4090_0000) as u32 | i_low) != 0 {
            return s * HUGE * HUGE; // overflow
        }
        if p_l + ovt > z - p_h {
            return s * HUGE * HUGE; // overflow
        }
    } else if (j & 0x7FFF_FFFF) >= 0x4090_CC00 {
        // z <= -1075
        if ((j as u32).wrapping_sub(0xC090_CC00) | i_low) != 0 {
            return s * TINY * TINY; // underflow
        }
        if p_l <= z - p_h {
            return s * TINY * TINY; // underflow
        }
    }

    // compute 2**(p_h + p_l)
    let i = j & 0x7FFF_FFFF;
    let mut k = (i >> 20) - 0x3FF;
    let mut n: i32 = 0;
    if i > 0x3FE0_0000 {
        // |z| > 0.5: set n = [z + 0.5]
        n = j.wrapping_add(0x0010_0000 >> (k + 1));
        k = ((n & 0x7FFF_FFFF) >> 20) - 0x3FF; // new k for n
        let t = set_hi(0.0, (n & !(0x000F_FFFF >> k)) as u32);
        n = ((n & 0x000F_FFFF) | 0x0010_0000) >> (20 - k);
        if j < 0 {
            n = -n;
        }
        p_h -= t;
    }
    let t = set_lo(p_l + p_h, 0);
    let u = t * lg2_h;
    let v = (p_l - (t - p_h)) * lg2 + t * lg2_l;
    z = u + v;
    let w = v - (z - u);
    let t = z * z;
    let t1 = z - t * (p1 + t * (p2 + t * (p3 + t * (p4 + t * p5))));
    let r = (z * t1) / ((t1 - 2.0) - (w + z * w));
    z = 1.0 - (r - z);
    let j = (hi_word(z) as i32).wrapping_add((n as u32 as i32).wrapping_shl(20));
    if (j >> 20) <= 0 {
        z = scalbn(z, n); // subnormal output
    } else {
        z = set_hi(z, (hi_word(z) as i32).wrapping_add((n as u32 as i32).wrapping_shl(20)) as u32);
    }
    s * z
}
