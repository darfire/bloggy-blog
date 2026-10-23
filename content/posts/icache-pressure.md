+++
title = 'Quirks of a CPU: Instruction Cache Pressure'
date = 2026-10-12T20:54:24Z
draft = true
+++

Take the same set of operations, apply them to the same batch of items,
and get the exact same output either way. Change nothing but which order
you loop over them in - item by item, or operation by operation - and one
version runs three times slower than the other. Nothing about the work
changes. Just the order it happens in.

## what's actually different here

Caches don't only hold data. Instructions have to get fetched into the
core too, and that fetch goes through its own cache - same fixed-size
lines, same sets, same limited associativity as any other cache, just
holding code instead of numbers. Most of the time this is invisible,
because most functions are small and called often enough to stay
resident. It stops being invisible once you're cycling through more code
than the cache can actually hold at once.

## a benchmark, and a wrong turn

To make that concrete: two ways to run the same N small functions over a
batch of floats. **Fused** - for each item, call all N functions on it
before moving to the next item. **Staged** - for each function, call it
on every item before moving to the next function. Same math per item
either way, same order of operations, just different loop nesting.

![An animated diagram of 16 instruction boxes in a row, with a blue highlighted window of 4 sliding across them as a black dot sweeps through all 16 one at a time, then jumps back to the start and repeats with a new dot.](/images/icache-fused.gif)

> **Fused.** One item runs every instruction, start to finish, before the
> next one begins - the window slides the whole way through and has to
> start cold again for each item.

![The same 16-instruction row, but now the highlighted window sits still on a block of 4 while four dots take turns sweeping across just those 4, the later ones visibly faster, before the window jumps to the next block of 4.](/images/icache-staged.gif)

> **Staged.** One instruction's worth of code stays hot while every item
> takes its turn through it - only the first item pays to fetch it.

The first version dispatched through an array of function pointers -
`ops[j](x)` in a loop. Fused came out close to 3x slower than staged,
which looked like confirmation of exactly the theory above: fused
repeatedly cycles through all N functions' worth of code, more than fits
in L1i, while staged only ever needs one function's code hot at a time.
Case closed, except it wasn't.

Checking the actual counters told a different story. `L1-icache-load-misses`
barely differed between the two versions - a couple thousand either way.
What differed by a factor of 25 was `branch-misses`: fused sat around a
20% misprediction rate on the indirect call, staged under 1%. The
slowdown was real. It just wasn't instruction cache pressure - it was the
CPU's indirect-branch predictor failing to learn a repeating sequence of
64 different call targets, a completely different mechanism that happens
to produce a similarly-shaped number.

## isolating the actual effect

Fixed by switching from function pointers to direct calls - compile-time-
known targets instead of a jump through a table, 96 generated functions
with genuinely distinct bodies (identical bodies just get folded back
together by the linker, which would have quietly undone the whole setup),
called by name in both loop orders. A direct call doesn't need branch
target prediction the way an indirect one does, so that confound goes
away on its own.

With that fixed, branch-misses came back nearly identical between the two
versions - noise, not signal. Icache-load-misses did not:

| nitems  | mode   | time    | icache misses | speedup |
|---------|--------|---------|----------------|---------|
| 2000    | fused  | 0.0059s | 4377           | 1.00x   |
| 2000    | staged | 0.0018s | 1861           | 3.28x   |
| 20000   | fused  | 0.0567s | 40774          | 1.00x   |
| 20000   | staged | 0.0187s | 1688           | 3.03x   |
| 200000  | fused  | 0.5809s | 287836         | 1.00x   |
| 200000  | staged | 0.1864s | 6449           | 3.12x   |

(full code in `code/icache-pipeline` if you want the generator script and
`bench.sh` that produced this)

The miss counts are the part worth sitting with, more than the times.
Fused's icache misses scale roughly linearly with item count, because
every single item re-triggers the same fetch churn across all 96
functions. Staged's barely move - it pays for each function's code once
per stage, not once per item, so growing the batch past that fixed cost
is close to free.

## where this shows up outside a microbenchmark

Nobody writes a 96-function synthetic pipeline by accident, but "many
small handlers, dispatched across a large batch, more combined code than
fits in L1i" is a real production shape, and there's a well-known system
built directly around avoiding it: [FD.io's VPP](https://s3-docs.fd.io/vpp/22.06/developer/corearchitecture/softwarearchitecture.html)
(Vector Packet Processing, originally from Cisco, now a networking
dataplane used widely enough to be the basis of multiple routers and
vSwitches). VPP structures packet processing as a directed graph of small
nodes - `dpdk-input`, `ip4-lookup`, and so on - and processes an entire
*vector* of packets through one node before moving to the next, instead
of running each packet through the whole graph individually. The project
is explicit that this is an instruction-cache decision: each node is
deliberately kept small enough to fit inside L1i, and because the first
packet in a vector warms that node's code up, every packet after it in
the same batch runs against an already-hot cache. That's "staged," at
production scale, built for the exact reason this post's benchmark shows
a 3x gap.

## so, what

The honest moral here isn't really about instruction caches. It's about
the first measurement I believed. A 3x gap with a plausible-sounding
explanation is still just a plausible-sounding explanation until a second,
independent counter confirms it's actually the mechanism you think it is.
Branch misprediction and icache pressure can produce numbers that look
the same from a distance - a stopwatch in one hand and a theory in the
other, and nothing stopping you from pairing them up wrong.

## references

- [FD.io VPP - Software Architecture](https://s3-docs.fd.io/vpp/22.06/developer/corearchitecture/softwarearchitecture.html) - graph-node design and the instruction-cache rationale behind vector processing
- [FD.io VPP - Scalar vs Vector packet processing](https://fd.io/docs/vpp/v2101/whatisvpp/scalar-vs-vector-packet-processing) - the scalar/fused vs vector/staged comparison directly
