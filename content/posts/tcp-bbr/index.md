+++
title = 'Ignoring the Loss: BBR'
date = 2026-11-09T09:00:00Z
draft = true
summary = "On a link that drops one packet in a hundred, Reno and cubic get 6Mbit/s out of 100. BBR gets 93. What it measures instead of loss, what that costs, and what happens when it shares a link."
tags = ['networking', 'TCP', 'performance']
+++

[The previous post](/posts/tcp-loss/) ended on a link that loses one
packet in a hundred at random. Reno got 6.1Mbit/s through it and cubic
5.5, out of 100. Both treat every loss as a sign that the path is full,
and cut their window accordingly. On that same link, at the same loss
rate, BBR gets 92.9Mbit/s.

BBR doesn't get there by being more aggressive, or by recovering from
losses faster. It reads a different signal. This post is about what that
signal is, what it costs, and how it gets along with other flows on the
same link.

## What a loss-based algorithm can't see

First, the vocabulary from the previous post. A TCP sender may have at
most *cwnd* (congestion window) packets in flight - sent but not yet
acknowledged. The bandwidth-delay product (BDP) is the bottleneck's rate
multiplied by the round-trip time: how much data has to be in flight to
keep the bottleneck busy. On the test link, 100Mbit with a 20ms round
trip, that's about 165 packets. With less in flight, the link sits idle
part of the time. With more, the extra waits in the queue in front of
the bottleneck, adding delay, and once the queue is full it's dropped:

<figure class="tl-bdp">
<style>
.tl-bdp svg { display: block; width: 100%; max-width: 680px; height: auto; margin: 0 auto; }
.tl-bdp text { fill: currentColor; font: 13px system-ui, sans-serif; }
.tl-bdp .title { font-weight: 600; font-size: 14px; }
.tl-bdp .muted { opacity: 0.7; }
.tl-bdp .small { font-size: 12px; }
.tl-bdp .frame { fill: none; stroke: rgb(var(--color-neutral-400)); stroke-width: 1; stroke-dasharray: 6 5; }
.tl-bdp .box { fill: rgba(var(--color-neutral-500), 0.06); stroke: rgb(var(--color-neutral-400)); stroke-width: 1.5; }
.tl-bdp .link { fill: rgba(var(--color-neutral-500), 0.15); stroke: rgb(var(--color-neutral-400)); stroke-width: 1; }
.tl-bdp .pkt { fill: rgb(var(--color-primary-600)); }
.tl-bdp .slot { fill: none; stroke: rgb(var(--color-neutral-400)); stroke-width: 1; stroke-dasharray: 2 2; }
.tl-bdp .drop { fill: none; stroke: rgb(var(--color-primary-600)); stroke-width: 1.5; stroke-dasharray: 3 2; }
.tl-bdp .drop-line { fill: none; stroke: rgb(var(--color-neutral-400)); stroke-width: 1; stroke-dasharray: 3 3; }
.tl-bdp .ack { fill: none; stroke: rgb(var(--color-neutral-500)); stroke-width: 2; }
.tl-bdp .ack-tick { stroke: rgb(var(--color-neutral-500)); stroke-width: 2; }
.tl-bdp .ack-head { fill: rgb(var(--color-neutral-500)); }
.tl-bdp .seg1 { fill: rgba(var(--color-neutral-500), 0.12); }
.tl-bdp .seg2 { fill: rgba(var(--color-primary-600), 0.18); }
.tl-bdp .seg3 { fill: rgba(var(--color-neutral-500), 0.32); }
.tl-bdp .tick { stroke: currentColor; stroke-width: 1; }
.dark .tl-bdp .pkt { fill: rgb(var(--color-primary-400)); }
.dark .tl-bdp .drop { stroke: rgb(var(--color-primary-400)); }
.dark .tl-bdp .seg2 { fill: rgba(var(--color-primary-400), 0.25); }
.dark .tl-bdp .ack, .dark .tl-bdp .ack-tick { stroke: rgb(var(--color-neutral-400)); }
.dark .tl-bdp .ack-head { fill: rgb(var(--color-neutral-400)); }
</style>
<svg viewBox="0 0 640 312" role="img" aria-labelledby="tl-bdp-title">
<title id="tl-bdp-title">A sender sends over a fast link into a router whose queue feeds a slower bottleneck link to the receiver; ACKs return to the sender. A packet arriving at a full queue is dropped. Below, a cwnd scale: under the BDP of about 165 packets the link is idle part of the time; between the BDP and BDP plus queue, about 282, the link is full and the queue adds delay; above that, packets are dropped.</title>
<defs><marker id="tl-bdp-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ack-head" d="M0,0 L10,5 L0,10 z"/></marker></defs>
<rect class="frame" x="8" y="8" width="624" height="200" rx="12"/>
<rect class="box" x="18" y="50" width="92" height="76" rx="8"/>
<text class="title" x="64" y="80" text-anchor="middle">sender</text>
<text class="muted small" x="64" y="99" text-anchor="middle">up to cwnd</text>
<text class="muted small" x="64" y="114" text-anchor="middle">in flight</text>
<rect class="link" x="110" y="74" width="120" height="28"/>
<text class="small" x="169" y="64" text-anchor="middle">fast link</text>
<rect class="pkt" x="118" y="83" width="12" height="10" rx="2"/>
<rect class="pkt" x="134" y="83" width="12" height="10" rx="2"/>
<rect class="pkt" x="150" y="83" width="12" height="10" rx="2"/>
<rect class="pkt" x="166" y="83" width="12" height="10" rx="2"/>
<rect class="pkt" x="182" y="83" width="12" height="10" rx="2"/>
<rect class="pkt" x="198" y="83" width="12" height="10" rx="2"/>
<rect class="box" x="230" y="58" width="122" height="60" rx="8"/>
<text class="small" x="291" y="50" text-anchor="middle">queue</text>
<text class="muted small" x="291" y="134" text-anchor="middle">bottleneck router</text>
<rect class="slot" x="240" y="83" width="12" height="10" rx="2"/>
<rect class="slot" x="255" y="83" width="12" height="10" rx="2"/>
<rect class="slot" x="270" y="83" width="12" height="10" rx="2"/>
<rect class="pkt" x="270" y="83" width="12" height="10" rx="2"/>
<rect class="slot" x="285" y="83" width="12" height="10" rx="2"/>
<rect class="pkt" x="285" y="83" width="12" height="10" rx="2"/>
<rect class="slot" x="300" y="83" width="12" height="10" rx="2"/>
<rect class="pkt" x="300" y="83" width="12" height="10" rx="2"/>
<rect class="slot" x="315" y="83" width="12" height="10" rx="2"/>
<rect class="pkt" x="315" y="83" width="12" height="10" rx="2"/>
<rect class="slot" x="330" y="83" width="12" height="10" rx="2"/>
<rect class="pkt" x="330" y="83" width="12" height="10" rx="2"/>
<g transform="rotate(25 222 127)"><rect class="drop" x="216" y="122" width="12" height="10" rx="2"/></g>
<path class="drop-line" d="M227,104 Q225,112 223,119"/>
<text class="small" x="208" y="127" text-anchor="end">queue full:</text>
<text class="small" x="208" y="142" text-anchor="end">dropped</text>
<rect class="link" x="352" y="81" width="168" height="14"/>
<text class="small" x="436" y="64" text-anchor="middle">bottleneck, 100Mbit/s</text>
<rect class="pkt" x="362" y="83" width="12" height="10" rx="2"/>
<rect class="pkt" x="392" y="83" width="12" height="10" rx="2"/>
<rect class="pkt" x="422" y="83" width="12" height="10" rx="2"/>
<rect class="pkt" x="452" y="83" width="12" height="10" rx="2"/>
<rect class="pkt" x="482" y="83" width="12" height="10" rx="2"/>
<text class="muted small" x="436" y="116" text-anchor="middle">spaced out by the link rate</text>
<rect class="box" x="520" y="50" width="96" height="76" rx="8"/>
<text class="title" x="568" y="92" text-anchor="middle">receiver</text>
<path class="ack" d="M568,126 L568,172 L64,172 L64,128" marker-end="url(#tl-bdp-head)"/>
<line class="ack-tick" x1="150" y1="167" x2="150" y2="177"/>
<line class="ack-tick" x1="190" y1="167" x2="190" y2="177"/>
<line class="ack-tick" x1="230" y1="167" x2="230" y2="177"/>
<line class="ack-tick" x1="380" y1="167" x2="380" y2="177"/>
<line class="ack-tick" x1="420" y1="167" x2="420" y2="177"/>
<line class="ack-tick" x1="460" y1="167" x2="460" y2="177"/>
<line class="ack-tick" x1="500" y1="167" x2="500" y2="177"/>
<text class="small" x="316" y="195" text-anchor="middle">ACKs: each one lets the sender send again</text>
<text class="small" x="20" y="242">cwnd, packets</text>
<rect class="seg1" x="20" y="252" width="275.0" height="26"/>
<rect class="seg2" x="295.0" y="252" width="195.0" height="26"/>
<rect class="seg3" x="490.0" y="252" width="130.0" height="26"/>
<text class="small" x="157.5" y="269" text-anchor="middle">link idle part of the time</text>
<text class="small" x="392.5" y="269" text-anchor="middle">link full, queue adds delay</text>
<text class="small" x="555.0" y="269" text-anchor="middle">drops</text>
<line class="tick" x1="20.0" y1="252" x2="20.0" y2="286"/>
<text class="muted small" x="20.0" y="300" text-anchor="start">0</text>
<line class="tick" x1="295.0" y1="252" x2="295.0" y2="286"/>
<text class="muted small" x="295.0" y="300" text-anchor="middle">BDP ≈ 165</text>
<line class="tick" x1="490.0" y1="252" x2="490.0" y2="286"/>
<text class="muted small" x="490.0" y="300" text-anchor="middle">BDP + queue ≈ 282</text>
</svg>
</figure>

Reno and cubic have one piece of feedback from the network: whether
packets get lost. They grow the window until something is lost, and then
back off. On a path where losses only come from a full queue, that works,
but it has two consequences that the previous post measured.

The first is that the queue at the bottleneck is always being filled.
A loss only happens once the queue has overflowed, so the algorithm spends
most of its time with a standing queue in front of the bottleneck, adding
delay to everything that shares it - on the test link, 7 to 9ms on top of
a 20ms round trip.

The second is that a loss that doesn't come from a full queue is
indistinguishable from one that does. Random loss gets the same response
as congestion, and throughput falls as one over the square root of the
loss rate.

## What BBR measures instead

BBR (Bottleneck Bandwidth and Round-trip propagation time) was published
by a group at Google in 2016, and has been in Linux since 4.9. Its idea
is to model the path with two numbers:

- **the bottleneck bandwidth**: the fastest rate at which the path has
  delivered data recently. Each ACK says how much data was delivered
  over how long, which gives a delivery rate sample; BBR keeps the
  maximum of those over the last ten or so round trips. A queue can slow
  delivery down, but nothing can make it faster than the bottleneck, so
  the maximum is the estimate.
- **the round-trip propagation time**: the smallest RTT seen over the
  last ten seconds. A queue can only add delay, so the minimum is the
  closest thing to the path's own round trip.

Their product is BBR's estimate of the BDP. Plotted against the amount
of data in flight, the round-trip time and delivery rate look like this:

<figure class="tl-op">
<style>
.tl-op svg { display: block; width: 100%; max-width: 680px; height: auto; margin: 0 auto; }
.tl-op text { fill: currentColor; font: 13px system-ui, sans-serif; }
.tl-op .muted { opacity: 0.7; }
.tl-op .small { font-size: 12px; }
.tl-op .r1 { fill: rgba(var(--color-neutral-500), 0.07); }
.tl-op .r2 { fill: rgba(var(--color-neutral-500), 0.14); }
.tl-op .r3 { fill: rgba(var(--color-neutral-500), 0.26); }
.tl-op .axis { stroke: rgb(var(--color-neutral-400)); stroke-width: 1.5; }
.tl-op .curve { fill: none; stroke: currentColor; stroke-width: 2; stroke-linejoin: round; }
.tl-op .curve-dash { stroke: currentColor; stroke-width: 2; stroke-dasharray: 4 4; opacity: 0.6; }
.tl-op .op-bbr { fill: rgb(var(--color-primary-600)); }
.tl-op .op-bbr-line { stroke: rgb(var(--color-primary-600)); stroke-width: 1.5; stroke-dasharray: 5 4; }
.tl-op .op-loss { fill: #eb6834; }
.tl-op .op-loss-line { stroke: #eb6834; stroke-width: 1.5; stroke-dasharray: 5 4; }
.tl-op .strong-bbr, .tl-op .strong-loss { font-weight: 600; }
.dark .tl-op .op-bbr { fill: rgb(var(--color-primary-400)); }
.dark .tl-op .op-bbr-line { stroke: rgb(var(--color-primary-400)); }
.dark .tl-op .op-loss { fill: #d95926; }
.dark .tl-op .op-loss-line { stroke: #d95926; }
</style>
<svg viewBox="0 0 640 330" role="img" aria-labelledby="tl-op-title">
<title id="tl-op-title">Round-trip time and delivery rate against the amount of data in flight. Below the BDP, the RTT stays at its minimum and the delivery rate rises with data in flight. Between the BDP and the BDP plus the queue, the delivery rate stays at the bottleneck rate while the RTT rises as the queue fills. Beyond that, packets are dropped. BBR aims for the BDP point; Reno and cubic grow until the queue is full and they see a loss.</title>
<rect class="r1" x="92" y="34" width="170" height="240"/>
<rect class="r2" x="262" y="34" width="180" height="240"/>
<rect class="r3" x="442" y="34" width="170" height="240"/>
<text class="muted small" x="177" y="26" text-anchor="middle">link not full</text>
<text class="muted small" x="352" y="26" text-anchor="middle">queue grows</text>
<text class="muted small" x="527" y="26" text-anchor="middle">queue full: drops</text>
<line class="axis" x1="92" y1="132" x2="612" y2="132"/>
<line class="axis" x1="92" y1="44" x2="92" y2="132"/>
<text class="small" x="84" y="56" text-anchor="end">RTT</text>
<text class="muted small" x="84" y="124" text-anchor="end">min RTT</text>
<path class="curve" d="M92,120 L262,120 L442,52"/>
<line class="curve-dash" x1="442" y1="52" x2="612" y2="52"/>
<line class="axis" x1="92" y1="274" x2="612" y2="274"/>
<line class="axis" x1="92" y1="186" x2="92" y2="274"/>
<text class="small" x="84" y="192" text-anchor="end">delivery rate</text>
<text class="muted small" x="84" y="210" text-anchor="end">bottleneck</text>
<path class="curve" d="M92,274 L262,206 L612,206"/>
<line class="op-bbr-line" x1="262" y1="34" x2="262" y2="282"/>
<line class="op-loss-line" x1="442" y1="34" x2="442" y2="282"/>
<circle class="op-bbr" cx="262" cy="120" r="5"/>
<circle class="op-bbr" cx="262" cy="206" r="5"/>
<circle class="op-loss" cx="442" cy="52" r="5"/>
<circle class="op-loss" cx="442" cy="206" r="5"/>
<text class="small" x="262" y="298" text-anchor="middle">BDP</text>
<text class="small strong-bbr" x="262" y="315" text-anchor="middle">BBR aims here</text>
<text class="small" x="442" y="298" text-anchor="middle">BDP + queue</text>
<text class="small strong-loss" x="442" y="315" text-anchor="middle">Reno and cubic end up here</text>
<text class="muted small" x="612" y="298" text-anchor="end">data in flight →</text>
</svg>
</figure>

Below the BDP, more data in flight means more throughput and no extra
delay. Past it, the bottleneck is already busy; more data only builds a
queue, and the round trip grows with it. Past BDP plus the queue, packets
are dropped. Reno and cubic only find out where they are at the
right-hand edge, from the drops. BBR tries to sit at the left-hand edge:
the link full, the queue empty.

## How it uses them

Instead of a window that grows and shrinks, BBR sets two things directly
from its model:

- **a pacing rate**: packets leave at gain × bottleneck bandwidth, spaced
  out evenly, not in bursts as ACKs come back;
- **a cap on data in flight**: twice the estimated BDP, as headroom for
  ACKs that arrive late or in batches.

The gain is how it keeps the model up to date. BBRv1 moves through four
states:

- **Startup**: a gain of 2.89, which roughly doubles the sending rate
  every round trip, like slow start. It leaves when the bandwidth
  estimate stops growing by 25% for three round trips in a row.
- **Drain**: a gain below 1, until the queue that Startup built is gone.
- **ProbeBW**, where it spends most of its time: a cycle of eight round
  trips with gains 1.25, 0.75, 1, 1, 1, 1, 1, 1. The 1.25 round checks
  whether more bandwidth has become available; the 0.75 round drains the
  queue that check built.
- **ProbeRTT**: if the minimum RTT hasn't been refreshed for ten seconds,
  BBR drops to four packets in flight for 200ms, so the queue empties
  and it can measure the propagation time again.

None of this involves loss. In BBRv1, the version in mainline Linux and
the one measured here, loss only matters during recovery itself, and to
a detector for traffic policers that cap a flow's rate by dropping
packets. BBRv3, which Google runs internally but which lives out of
tree, does react to loss, once it goes above about 2% per round trip.

## On the lossy link

Same link and setup as the previous post - client, router and server
namespaces in one kernel, netem on the router adding 10ms each way, a
100Mbit bottleneck with about 117 packets of queue, and random loss on
the data direction. Linux 7.2.6, single 20s runs:

| loss  | reno, Mbit/s | cubic, Mbit/s | bbr, Mbit/s |
|-------|-------------:|--------------:|------------:|
| 0     |         93.4 |          95.2 |        94.2 |
| 0.01% |         62.5 |          71.6 |        93.2 |
| 0.1%  |         24.2 |          21.1 |        94.1 |
| 1%    |          6.1 |           5.5 |        92.9 |

The bbr column doesn't move. An earlier, separate run gave 94.2, 94.0 and
93.0 at 0, 0.1% and 1%.

The queue BBR keeps is also smaller. With no random loss, the average
RTT was 3.2ms above the minimum, against 6.7 for reno and 9.2 for cubic.

## What it costs

BBR isn't free of losses of its own. With no random loss at all, a 20s
run retransmitted 528 to 538 packets, against 22 for cubic. The kernel's
per-ACK trace of one such run shows where they come from:

<figure class="tl-bbrrun">
<style>
.tl-bbrrun svg { display: block; width: 100%; max-width: 680px; height: auto; margin: 0 auto; }
.tl-bbrrun text { fill: currentColor; font: 13px system-ui, sans-serif; }
.tl-bbrrun .muted { opacity: 0.7; }
.tl-bbrrun .small { font-size: 12px; }
.tl-bbrrun .strong { font-weight: 600; }
.tl-bbrrun .grid { stroke: rgba(var(--color-neutral-400), 0.5); stroke-width: 1; }
.tl-bbrrun .line { fill: none; stroke: rgb(var(--color-primary-600)); stroke-width: 1.25; stroke-linejoin: round; }
.tl-bbrrun .band { fill: rgba(var(--color-primary-600), 0.35); }
.tl-bbrrun .note { fill: none; stroke: currentColor; stroke-width: 1; }
.dark .tl-bbrrun .line { stroke: rgb(var(--color-primary-400)); }
.dark .tl-bbrrun .band { fill: rgba(var(--color-primary-400), 0.35); }
</style>
<svg viewBox="0 0 640 380" role="img" aria-labelledby="tl-bbrrun-title">
<title id="tl-bbrrun-title">One 20-second BBR run with no random loss, from the kernel's per-ACK trace. Top: cwnd jumps during Startup, where all of the run's 528 retransmits happen, then holds at about 360 packets, except for a dip to 4 packets for about 0.23 seconds at 10.2 seconds: ProbeRTT. Bottom: half a second of the smoothed RTT, which rises by a few milliseconds every 8 round trips, when ProbeBW sends at 1.25 times its bandwidth estimate, and falls back after the 0.75 round.</title>
<polygon class="band" points="70.0,164.2 70.7,158.1 71.4,144.4 72.1,113.2 72.8,68.6 73.4,51.3 74.1,73.2 74.8,56.7 75.5,52.1 76.2,93.1 76.9,88.5 77.6,88.5 78.2,90.3 78.9,90.3 79.6,90.3 80.3,91.6 81.0,89.8 81.7,89.8 82.4,91.6 83.1,92.9 83.8,92.9 84.4,92.9 85.1,92.9 85.8,91.1 86.5,91.1 87.2,92.9 87.9,92.9 88.6,92.9 89.2,92.9 89.9,92.9 90.6,91.1 91.3,91.1 92.0,92.9 92.7,91.6 93.4,91.6 94.1,91.6 94.8,89.8 95.4,89.8 96.1,91.6 96.8,91.6 97.5,91.6 98.2,91.6 98.9,91.6 99.6,89.8 100.2,89.8 100.9,91.6 101.6,91.6 102.3,92.0 103.0,92.0 103.7,92.0 104.4,90.3 105.1,90.3 105.8,92.0 106.4,92.0 107.1,92.0 107.8,92.0 108.5,90.3 109.2,90.3 109.9,92.0 110.6,92.0 111.2,92.0 111.9,92.4 112.6,92.4 113.3,90.7 114.0,90.7 114.7,92.4 115.4,92.4 116.1,92.4 116.8,92.4 117.4,92.4 118.1,90.7 118.8,90.7 119.5,92.4 120.2,92.4 120.9,92.9 121.6,92.9 122.2,91.1 122.9,91.1 123.6,92.9 124.3,92.9 125.0,92.9 125.7,92.9 126.4,92.9 127.1,91.1 127.8,91.1 128.4,92.9 129.1,92.9 129.8,92.9 130.5,92.9 131.2,92.9 131.9,91.1 132.6,91.1 133.2,92.9 133.9,92.9 134.6,92.9 135.3,92.9 136.0,91.1 136.7,91.1 137.4,92.9 138.1,92.9 138.8,92.9 139.4,92.9 140.1,92.9 140.8,91.1 141.5,91.1 142.2,92.9 142.9,92.9 143.6,92.9 144.2,92.9 144.9,92.9 145.6,91.1 146.3,91.1 147.0,92.9 147.7,92.9 148.4,92.9 149.1,92.9 149.8,91.1 150.4,91.1 151.1,92.9 151.8,92.9 152.5,92.9 153.2,92.9 153.9,92.9 154.6,91.1 155.2,91.1 155.9,92.9 156.6,92.9 157.3,92.9 158.0,92.9 158.7,92.4 159.4,91.1 160.1,92.9 160.8,92.9 161.4,92.9 162.1,92.9 162.8,92.9 163.5,91.1 164.2,91.1 164.9,92.9 165.6,92.9 166.2,92.9 166.9,92.9 167.6,92.9 168.3,91.1 169.0,91.1 169.7,92.9 170.4,92.9 171.1,92.9 171.8,92.9 172.4,91.3 173.1,91.1 173.8,91.1 174.5,92.9 175.2,92.9 175.9,92.9 176.6,92.9 177.2,91.1 177.9,91.1 178.6,92.9 179.3,92.9 180.0,92.9 180.7,92.9 181.4,92.9 182.1,91.1 182.8,91.1 183.4,92.9 184.1,92.9 184.8,92.9 185.5,92.9 186.2,91.1 186.9,91.1 187.6,92.9 188.2,92.9 188.9,92.9 189.6,92.9 190.3,92.9 191.0,91.1 191.7,91.1 192.4,92.9 193.1,92.9 193.8,92.9 194.4,92.9 195.1,92.9 195.8,91.1 196.5,91.1 197.2,92.9 197.9,92.9 198.6,92.9 199.2,92.9 199.9,91.1 200.6,91.1 201.3,92.9 202.0,92.9 202.7,92.9 203.4,92.9 204.1,92.9 204.8,91.1 205.4,91.1 206.1,92.9 206.8,92.9 207.5,92.9 208.2,92.9 208.9,91.6 209.6,89.8 210.3,89.8 210.9,91.6 211.6,91.6 212.3,91.6 213.0,92.0 213.7,90.3 214.4,90.3 215.1,92.0 215.8,92.0 216.4,92.9 217.1,92.9 217.8,92.9 218.5,91.1 219.2,91.1 219.9,92.9 220.6,92.9 221.2,92.9 221.9,92.9 222.6,90.3 223.3,90.3 224.0,92.0 224.7,92.0 225.4,92.0 226.1,92.0 226.8,92.0 227.4,90.3 228.1,90.3 228.8,92.0 229.5,92.9 230.2,92.9 230.9,92.9 231.6,92.9 232.2,91.1 232.9,92.9 233.6,92.9 234.3,92.9 235.0,92.9 235.7,92.0 236.4,90.3 237.1,90.3 237.8,92.0 238.4,92.0 239.1,92.0 239.8,92.0 240.5,92.0 241.2,90.3 241.9,90.3 242.6,92.0 243.3,92.9 243.9,92.9 244.6,92.9 245.3,91.1 246.0,91.1 246.7,92.9 247.4,92.9 248.1,92.9 248.8,92.9 249.4,92.9 250.1,91.1 250.8,91.1 251.5,92.9 252.2,92.9 252.9,92.9 253.6,92.9 254.2,92.9 254.9,91.1 255.6,91.1 256.3,92.9 257.0,92.9 257.7,92.9 258.4,92.9 259.1,91.1 259.8,91.1 260.4,92.9 261.1,92.9 261.8,92.9 262.5,92.9 263.2,92.9 263.9,91.1 264.6,91.1 265.2,92.9 265.9,92.9 266.6,92.9 267.3,92.9 268.0,92.9 268.7,91.1 269.4,91.1 270.1,92.9 270.8,92.9 271.4,92.9 272.1,92.9 272.8,91.1 273.5,91.1 274.2,92.9 274.9,92.9 275.6,92.9 276.2,92.9 276.9,92.9 277.6,91.1 278.3,91.1 279.0,92.9 279.7,92.9 280.4,92.9 281.1,92.9 281.8,92.9 282.4,91.1 283.1,91.1 283.8,92.9 284.5,92.9 285.2,92.9 285.9,92.9 286.6,91.1 287.2,91.1 287.9,92.9 288.6,92.9 289.3,92.9 290.0,92.9 290.7,91.6 291.4,89.8 292.1,89.8 292.8,91.6 293.4,91.6 294.1,91.6 294.8,91.6 295.5,90.3 296.2,90.3 296.9,92.0 297.6,92.0 298.2,92.9 298.9,92.9 299.6,92.9 300.3,91.1 301.0,91.1 301.7,92.9 302.4,92.9 303.1,92.9 303.8,92.9 304.4,92.9 305.1,91.1 305.8,91.1 306.5,92.9 307.2,92.9 307.9,92.9 308.6,92.9 309.3,91.1 309.9,91.1 310.6,92.9 311.3,92.9 312.0,92.9 312.7,92.9 313.4,92.9 314.1,91.1 314.8,91.1 315.4,92.9 316.1,92.9 316.8,92.9 317.5,92.9 318.2,91.1 318.9,91.1 319.6,92.9 320.2,92.9 320.9,92.9 321.6,92.9 322.3,92.9 323.0,91.1 323.7,91.1 324.4,92.9 325.1,92.9 325.8,92.9 326.4,92.9 327.1,92.9 327.8,91.1 328.5,91.1 329.2,92.9 329.9,92.9 330.6,92.9 331.2,92.9 331.9,91.1 332.6,91.1 333.3,92.9 334.0,92.9 334.7,92.9 335.4,92.9 336.1,92.0 336.8,90.3 337.4,90.3 338.1,92.0 338.8,92.0 339.5,92.0 340.2,92.0 340.9,92.0 341.6,90.3 342.2,90.3 342.9,92.0 343.6,92.0 344.3,92.0 345.0,92.0 345.7,90.3 346.4,90.3 347.1,92.0 347.8,92.0 348.4,92.0 349.1,92.9 349.8,92.9 350.5,91.1 351.2,91.1 351.9,169.1 352.6,169.1 353.2,169.1 353.9,169.1 354.6,169.1 355.3,169.1 356.0,169.1 356.7,169.1 357.4,92.4 358.1,92.4 358.8,91.6 359.4,89.8 360.1,89.8 360.8,91.6 361.5,91.6 362.2,91.6 362.9,91.6 363.6,91.6 364.3,89.8 364.9,89.8 365.6,92.0 366.3,92.0 367.0,92.0 367.7,92.0 368.4,90.7 369.1,90.7 369.8,92.4 370.4,92.4 371.1,92.4 371.8,92.4 372.5,92.4 373.2,90.7 373.9,90.7 374.6,92.4 375.3,92.4 375.9,92.4 376.6,92.4 377.3,92.4 378.0,90.7 378.7,90.7 379.4,92.4 380.1,92.4 380.8,92.4 381.4,92.4 382.1,92.4 382.8,90.7 383.5,90.7 384.2,92.4 384.9,92.4 385.6,92.4 386.2,92.4 386.9,90.7 387.6,90.7 388.3,92.4 389.0,92.4 389.7,92.4 390.4,92.4 391.1,92.4 391.8,90.7 392.4,90.7 393.1,92.4 393.8,92.4 394.5,92.4 395.2,92.4 395.9,92.4 396.6,90.7 397.2,90.7 397.9,92.4 398.6,92.4 399.3,92.4 400.0,92.4 400.7,92.4 401.4,90.7 402.1,90.7 402.8,92.0 403.4,92.0 404.1,92.0 404.8,92.0 405.5,90.3 406.2,90.3 406.9,92.4 407.6,92.4 408.2,92.4 408.9,92.4 409.6,92.4 410.3,90.7 411.0,90.7 411.7,92.4 412.4,92.4 413.1,92.4 413.8,92.4 414.4,92.4 415.1,90.7 415.8,90.7 416.5,92.4 417.2,92.4 417.9,92.4 418.6,92.4 419.3,90.7 419.9,90.7 420.6,90.7 421.3,92.4 422.0,92.4 422.7,92.4 423.4,92.4 424.1,90.7 424.8,90.7 425.4,92.4 426.1,92.4 426.8,92.4 427.5,92.4 428.2,92.4 428.9,90.7 429.6,90.7 430.3,92.4 430.9,92.4 431.6,92.4 432.3,92.4 433.0,92.4 433.7,90.7 434.4,90.7 435.1,92.4 435.8,92.4 436.4,92.4 437.1,92.4 437.8,90.7 438.5,90.7 439.2,92.4 439.9,92.4 440.6,92.4 441.2,92.4 441.9,92.4 442.6,90.7 443.3,90.7 444.0,92.4 444.7,92.4 445.4,92.4 446.1,92.4 446.8,92.4 447.4,90.7 448.1,90.7 448.8,92.4 449.5,92.4 450.2,92.4 450.9,91.6 451.6,91.6 452.2,89.8 452.9,89.8 453.6,91.6 454.3,91.6 455.0,91.6 455.7,91.6 456.4,89.8 457.1,89.8 457.8,91.6 458.4,91.6 459.1,91.6 459.8,91.6 460.5,91.6 461.2,90.3 461.9,90.3 462.6,92.0 463.2,92.0 463.9,92.0 464.6,92.0 465.3,92.0 466.0,90.3 466.7,90.3 467.4,92.0 468.1,92.0 468.8,92.0 469.4,92.0 470.1,92.0 470.8,90.7 471.5,90.7 472.2,92.4 472.9,92.4 473.6,92.4 474.3,92.4 474.9,90.7 475.6,90.7 476.3,92.4 477.0,92.4 477.7,92.4 478.4,92.4 479.1,92.4 479.8,90.7 480.4,90.7 481.1,92.4 481.8,92.4 482.5,92.4 483.2,92.4 483.9,92.4 484.6,90.7 485.2,90.7 485.9,92.4 486.6,92.4 487.3,92.4 488.0,92.4 488.7,90.7 489.4,90.7 490.1,92.4 490.8,92.4 491.4,92.4 492.1,92.4 492.8,92.4 493.5,90.7 494.2,90.7 494.9,92.4 495.6,92.4 496.2,92.4 496.9,92.4 497.6,92.4 498.3,90.7 499.0,90.7 499.7,92.4 500.4,92.4 501.1,92.4 501.8,92.4 502.4,92.4 503.1,90.7 503.8,90.7 504.5,92.4 505.2,92.4 505.9,92.4 506.6,92.4 507.2,90.7 507.9,90.7 508.6,92.4 509.3,92.4 510.0,92.4 510.7,92.4 511.4,92.4 512.1,90.7 512.8,90.7 513.4,92.4 514.1,92.4 514.8,92.4 515.5,92.4 516.2,92.4 516.9,90.7 517.6,90.7 518.2,92.4 518.9,92.4 519.6,92.4 520.3,92.4 521.0,91.3 521.7,90.7 522.4,90.7 523.1,92.4 523.8,92.4 524.4,92.4 525.1,92.4 525.8,90.7 526.5,90.7 527.2,92.4 527.9,92.4 528.6,92.4 529.2,92.4 529.9,92.4 530.6,90.7 531.3,90.7 532.0,92.4 532.7,92.4 533.4,92.4 534.1,92.4 534.8,92.4 535.4,90.7 536.1,90.7 536.8,92.4 537.5,92.4 538.2,92.4 538.9,92.4 539.6,90.7 540.2,90.7 540.9,92.4 541.6,92.4 542.3,92.4 543.0,92.4 543.7,92.4 544.4,90.7 545.1,90.7 545.8,90.7 546.4,90.7 547.1,90.7 547.8,90.7 548.5,90.7 549.2,89.0 549.9,89.0 550.6,90.7 551.2,90.7 551.9,90.7 552.6,90.7 553.3,90.7 554.0,89.0 554.7,89.0 555.4,90.7 556.1,90.7 556.8,91.1 557.4,91.1 558.1,89.4 558.8,89.4 559.5,91.1 560.2,91.1 560.9,91.1 561.6,91.1 562.3,91.1 562.9,89.4 563.6,89.4 564.3,91.1 565.0,91.1 565.7,91.1 566.4,91.1 567.1,91.1 567.8,89.4 568.4,89.4 569.1,91.1 569.8,91.1 570.5,91.1 571.2,91.1 571.9,91.1 572.6,89.8 573.2,89.8 573.9,91.6 574.6,91.6 575.3,91.6 576.0,91.6 576.7,89.8 577.4,89.8 578.1,91.6 578.8,91.6 579.4,91.6 580.1,91.6 580.8,91.6 581.5,90.7 582.2,90.7 582.9,92.0 583.6,92.0 584.2,92.0 584.9,92.0 585.6,92.0 586.3,90.3 587.0,90.3 587.7,90.7 588.4,90.7 589.1,90.7 589.8,90.7 590.4,89.0 591.1,89.0 591.8,91.1 592.5,91.1 593.2,91.1 593.9,91.1 594.6,92.0 595.2,90.7 595.9,90.7 596.6,92.4 597.3,92.4 598.0,92.4 598.7,92.4 599.4,92.4 600.1,90.7 600.8,90.7 601.4,92.4 602.1,92.4 602.8,92.4 603.5,92.4 604.2,90.7 604.9,90.7 605.6,92.4 606.2,92.4 606.9,92.4 607.6,92.4 608.3,92.4 609.0,90.7 609.7,90.7 610.4,92.0 611.1,92.0 611.8,91.6 612.4,90.7 613.1,90.7 613.8,89.0 614.5,89.0 615.2,90.7 615.9,90.7 616.6,90.7 617.3,91.1 617.9,91.1 618.6,89.4 619.3,89.4 619.3,93.7 618.6,91.1 617.9,91.1 617.3,91.1 616.6,91.1 615.9,90.7 615.2,92.0 614.5,92.0 613.8,90.7 613.1,90.7 612.4,91.6 611.8,92.0 611.1,92.0 610.4,93.7 609.7,93.7 609.0,92.4 608.3,92.4 607.6,92.4 606.9,92.4 606.2,92.4 605.6,93.7 604.9,93.7 604.2,92.4 603.5,92.4 602.8,92.4 602.1,92.4 601.4,93.7 600.8,93.7 600.1,92.4 599.4,92.4 598.7,92.4 598.0,92.4 597.3,92.4 596.6,93.7 595.9,93.7 595.2,92.4 594.6,92.4 593.9,92.0 593.2,91.1 592.5,91.1 591.8,92.4 591.1,92.4 590.4,90.7 589.8,90.7 589.1,90.7 588.4,90.7 587.7,91.1 587.0,93.3 586.3,92.0 585.6,92.0 584.9,92.0 584.2,92.0 583.6,92.0 582.9,93.7 582.2,93.7 581.5,92.4 580.8,91.6 580.1,91.6 579.4,91.6 578.8,91.6 578.1,92.9 577.4,92.9 576.7,91.6 576.0,91.6 575.3,91.6 574.6,91.6 573.9,91.6 573.2,92.9 572.6,90.9 571.9,91.6 571.2,91.1 570.5,91.1 569.8,91.1 569.1,92.4 568.4,92.4 567.8,91.1 567.1,91.1 566.4,91.1 565.7,91.1 565.0,91.1 564.3,92.4 563.6,92.4 562.9,91.1 562.3,91.1 561.6,91.1 560.9,91.1 560.2,91.1 559.5,92.4 558.8,92.4 558.1,91.1 557.4,91.1 556.8,91.1 556.1,91.1 555.4,90.7 554.7,92.0 554.0,90.7 553.3,90.7 552.6,90.7 551.9,90.7 551.2,90.7 550.6,92.0 549.9,92.0 549.2,90.7 548.5,90.7 547.8,90.7 547.1,90.7 546.4,90.7 545.8,92.0 545.1,93.7 544.4,92.4 543.7,92.4 543.0,92.4 542.3,92.4 541.6,92.4 540.9,93.7 540.2,93.7 539.6,92.4 538.9,92.4 538.2,92.4 537.5,92.4 536.8,93.7 536.1,93.7 535.4,92.4 534.8,92.4 534.1,92.4 533.4,92.4 532.7,92.4 532.0,93.7 531.3,93.7 530.6,92.4 529.9,92.4 529.2,92.4 528.6,92.4 527.9,92.4 527.2,93.7 526.5,93.7 525.8,92.4 525.1,92.4 524.4,92.4 523.8,92.4 523.1,92.4 522.4,93.7 521.7,90.9 521.0,92.4 520.3,92.4 519.6,92.4 518.9,92.4 518.2,93.7 517.6,93.7 516.9,92.4 516.2,92.4 515.5,92.4 514.8,92.4 514.1,92.4 513.4,93.7 512.8,93.7 512.1,92.4 511.4,92.4 510.7,92.4 510.0,92.4 509.3,92.4 508.6,93.7 507.9,93.7 507.2,92.4 506.6,92.4 505.9,92.4 505.2,92.4 504.5,92.4 503.8,93.7 503.1,92.4 502.4,92.4 501.8,92.4 501.1,92.4 500.4,92.4 499.7,93.7 499.0,93.7 498.3,92.4 497.6,92.4 496.9,92.4 496.2,92.4 495.6,92.4 494.9,93.7 494.2,93.7 493.5,92.4 492.8,92.4 492.1,92.4 491.4,92.4 490.8,92.4 490.1,93.7 489.4,93.7 488.7,92.4 488.0,92.4 487.3,92.4 486.6,92.4 485.9,93.7 485.2,93.7 484.6,92.4 483.9,92.4 483.2,92.4 482.5,92.4 481.8,92.4 481.1,93.7 480.4,93.7 479.8,92.4 479.1,92.4 478.4,92.4 477.7,92.4 477.0,92.4 476.3,93.7 475.6,93.7 474.9,92.4 474.3,92.4 473.6,92.4 472.9,92.4 472.2,92.4 471.5,93.7 470.8,92.4 470.1,92.4 469.4,92.0 468.8,92.0 468.1,92.0 467.4,93.3 466.7,93.3 466.0,92.0 465.3,92.0 464.6,92.0 463.9,92.0 463.2,92.0 462.6,93.3 461.9,93.3 461.2,92.0 460.5,92.0 459.8,91.6 459.1,91.6 458.4,91.6 457.8,92.9 457.1,92.9 456.4,91.6 455.7,91.6 455.0,91.6 454.3,91.6 453.6,91.6 452.9,92.9 452.2,91.6 451.6,91.6 450.9,92.4 450.2,92.4 449.5,92.4 448.8,93.7 448.1,93.7 447.4,92.4 446.8,92.4 446.1,92.4 445.4,92.4 444.7,92.4 444.0,93.7 443.3,93.7 442.6,92.4 441.9,92.4 441.2,92.4 440.6,92.4 439.9,92.4 439.2,93.7 438.5,93.7 437.8,92.4 437.1,92.4 436.4,92.4 435.8,92.4 435.1,93.7 434.4,93.7 433.7,92.4 433.0,92.4 432.3,92.4 431.6,92.4 430.9,92.4 430.3,93.7 429.6,93.7 428.9,92.4 428.2,92.4 427.5,92.4 426.8,92.4 426.1,92.4 425.4,93.7 424.8,93.7 424.1,92.4 423.4,92.4 422.7,92.4 422.0,92.4 421.3,92.4 420.6,93.7 419.9,90.7 419.3,92.4 418.6,92.4 417.9,92.4 417.2,92.4 416.5,93.7 415.8,93.7 415.1,92.4 414.4,92.4 413.8,92.4 413.1,92.4 412.4,92.4 411.7,93.7 411.0,93.7 410.3,92.4 409.6,92.4 408.9,92.4 408.2,92.4 407.6,92.4 406.9,93.7 406.2,93.7 405.5,92.0 404.8,92.0 404.1,92.0 403.4,92.0 402.8,92.0 402.1,93.7 401.4,92.0 400.7,92.4 400.0,92.4 399.3,92.4 398.6,92.4 397.9,93.7 397.2,93.7 396.6,92.4 395.9,92.4 395.2,92.4 394.5,92.4 393.8,92.4 393.1,93.7 392.4,93.7 391.8,92.4 391.1,92.4 390.4,92.4 389.7,92.4 389.0,92.4 388.3,93.7 387.6,93.7 386.9,92.4 386.2,92.4 385.6,92.4 384.9,92.4 384.2,92.4 383.5,93.7 382.8,92.4 382.1,92.4 381.4,92.4 380.8,92.4 380.1,92.4 379.4,93.7 378.7,93.7 378.0,92.4 377.3,92.4 376.6,92.4 375.9,92.4 375.3,92.4 374.6,93.7 373.9,93.7 373.2,92.4 372.5,92.4 371.8,92.4 371.1,92.4 370.4,92.4 369.8,93.7 369.1,93.7 368.4,92.4 367.7,92.0 367.0,92.0 366.3,92.0 365.6,93.3 364.9,93.3 364.3,91.6 363.6,91.6 362.9,91.6 362.2,91.6 361.5,91.6 360.8,92.9 360.1,92.9 359.4,91.6 358.8,92.9 358.1,92.4 357.4,169.1 356.7,169.1 356.0,169.1 355.3,169.1 354.6,169.1 353.9,169.1 353.2,169.1 352.6,169.1 351.9,169.1 351.2,169.1 350.5,92.9 349.8,92.9 349.1,92.9 348.4,92.9 347.8,92.0 347.1,93.3 346.4,93.3 345.7,92.0 345.0,92.0 344.3,92.0 343.6,92.0 342.9,92.0 342.2,93.3 341.6,92.0 340.9,92.0 340.2,92.0 339.5,92.0 338.8,92.0 338.1,93.3 337.4,93.3 336.8,92.0 336.1,92.9 335.4,92.9 334.7,92.9 334.0,92.9 333.3,94.2 332.6,94.2 331.9,92.9 331.2,92.9 330.6,92.9 329.9,92.9 329.2,92.9 328.5,94.2 327.8,92.9 327.1,92.9 326.4,92.9 325.8,92.9 325.1,92.9 324.4,94.2 323.7,94.2 323.0,92.9 322.3,92.9 321.6,92.9 320.9,92.9 320.2,92.9 319.6,94.2 318.9,94.2 318.2,92.9 317.5,92.9 316.8,92.9 316.1,92.9 315.4,94.2 314.8,94.2 314.1,92.9 313.4,92.9 312.7,92.9 312.0,92.9 311.3,92.9 310.6,94.2 309.9,94.2 309.3,92.9 308.6,92.9 307.9,92.9 307.2,92.9 306.5,92.9 305.8,94.2 305.1,92.9 304.4,92.9 303.8,92.9 303.1,92.9 302.4,92.9 301.7,94.2 301.0,94.2 300.3,92.9 299.6,92.9 298.9,92.9 298.2,92.9 297.6,92.9 296.9,93.3 296.2,93.3 295.5,92.0 294.8,91.6 294.1,91.6 293.4,91.6 292.8,92.9 292.1,92.9 291.4,91.6 290.7,92.9 290.0,92.9 289.3,92.9 288.6,92.9 287.9,94.2 287.2,94.2 286.6,92.9 285.9,92.9 285.2,92.9 284.5,92.9 283.8,92.9 283.1,94.2 282.4,92.4 281.8,92.9 281.1,92.9 280.4,92.9 279.7,92.9 279.0,94.2 278.3,94.2 277.6,92.9 276.9,92.9 276.2,92.9 275.6,92.9 274.9,92.9 274.2,94.2 273.5,94.2 272.8,92.9 272.1,92.9 271.4,92.9 270.8,92.9 270.1,92.9 269.4,94.2 268.7,92.9 268.0,92.9 267.3,92.9 266.6,92.9 265.9,92.9 265.2,94.2 264.6,94.2 263.9,92.9 263.2,92.9 262.5,92.9 261.8,92.9 261.1,92.9 260.4,94.2 259.8,94.2 259.1,92.9 258.4,92.9 257.7,92.9 257.0,92.9 256.3,92.9 255.6,94.2 254.9,92.9 254.2,92.9 253.6,92.9 252.9,92.9 252.2,92.9 251.5,94.2 250.8,94.2 250.1,92.9 249.4,92.9 248.8,92.9 248.1,92.9 247.4,92.9 246.7,94.2 246.0,94.2 245.3,92.9 244.6,92.9 243.9,92.9 243.3,92.9 242.6,93.3 241.9,93.3 241.2,92.0 240.5,92.0 239.8,92.0 239.1,92.0 238.4,92.0 237.8,93.3 237.1,93.3 236.4,92.0 235.7,92.9 235.0,92.9 234.3,92.9 233.6,92.9 232.9,94.2 232.2,94.2 231.6,92.9 230.9,92.9 230.2,92.9 229.5,92.9 228.8,93.3 228.1,93.3 227.4,92.0 226.8,92.0 226.1,92.0 225.4,92.0 224.7,92.0 224.0,93.3 223.3,93.3 222.6,92.9 221.9,92.9 221.2,92.9 220.6,92.9 219.9,92.9 219.2,94.2 218.5,92.9 217.8,92.9 217.1,92.9 216.4,92.9 215.8,92.9 215.1,93.3 214.4,93.3 213.7,92.0 213.0,92.0 212.3,92.0 211.6,91.6 210.9,91.6 210.3,92.9 209.6,91.6 208.9,92.9 208.2,92.9 207.5,92.9 206.8,92.9 206.1,94.2 205.4,94.2 204.8,92.9 204.1,92.9 203.4,92.9 202.7,92.9 202.0,92.9 201.3,94.2 200.6,94.2 199.9,92.9 199.2,92.9 198.6,92.9 197.9,92.9 197.2,92.9 196.5,94.2 195.8,92.9 195.1,92.9 194.4,92.9 193.8,92.9 193.1,92.9 192.4,94.2 191.7,94.2 191.0,92.9 190.3,92.9 189.6,92.9 188.9,92.9 188.2,92.9 187.6,94.2 186.9,94.2 186.2,92.9 185.5,92.9 184.8,92.9 184.1,92.9 183.4,94.2 182.8,94.2 182.1,92.9 181.4,92.9 180.7,92.9 180.0,92.9 179.3,92.9 178.6,94.2 177.9,94.2 177.2,92.9 176.6,92.9 175.9,92.9 175.2,92.9 174.5,92.9 173.8,94.2 173.1,91.1 172.4,92.9 171.8,92.9 171.1,92.9 170.4,92.9 169.7,94.2 169.0,94.2 168.3,92.9 167.6,92.9 166.9,92.9 166.2,92.9 165.6,92.9 164.9,94.2 164.2,94.2 163.5,92.9 162.8,92.9 162.1,92.9 161.4,92.9 160.8,92.9 160.1,94.2 159.4,92.2 158.7,92.9 158.0,92.9 157.3,92.9 156.6,92.9 155.9,94.2 155.2,94.2 154.6,92.9 153.9,92.9 153.2,92.9 152.5,92.9 151.8,92.9 151.1,94.2 150.4,94.2 149.8,92.9 149.1,92.9 148.4,92.9 147.7,92.9 147.0,92.9 146.3,94.2 145.6,92.9 144.9,92.9 144.2,92.9 143.6,92.9 142.9,92.9 142.2,94.2 141.5,94.2 140.8,92.9 140.1,92.9 139.4,92.9 138.8,92.9 138.1,92.9 137.4,94.2 136.7,94.2 136.0,92.9 135.3,92.9 134.6,92.9 133.9,92.9 133.2,92.9 132.6,94.2 131.9,92.9 131.2,92.9 130.5,92.9 129.8,92.9 129.1,92.9 128.4,94.2 127.8,94.2 127.1,92.9 126.4,92.9 125.7,92.9 125.0,92.9 124.3,92.9 123.6,94.2 122.9,94.2 122.2,92.9 121.6,92.9 120.9,92.9 120.2,92.9 119.5,92.4 118.8,93.7 118.1,92.4 117.4,92.4 116.8,92.4 116.1,92.4 115.4,92.4 114.7,93.7 114.0,93.7 113.3,92.4 112.6,92.4 111.9,92.4 111.2,92.4 110.6,92.0 109.9,93.3 109.2,93.3 108.5,92.0 107.8,92.0 107.1,92.0 106.4,92.0 105.8,92.0 105.1,93.3 104.4,92.0 103.7,92.0 103.0,92.0 102.3,92.0 101.6,92.0 100.9,92.9 100.2,92.9 99.6,91.6 98.9,91.6 98.2,91.6 97.5,91.6 96.8,91.6 96.1,92.9 95.4,92.9 94.8,91.6 94.1,91.6 93.4,91.6 92.7,92.9 92.0,92.9 91.3,94.2 90.6,92.9 89.9,92.9 89.2,92.9 88.6,92.9 87.9,92.9 87.2,94.2 86.5,94.2 85.8,92.9 85.1,92.9 84.4,92.9 83.8,92.9 83.1,92.9 82.4,92.9 81.7,92.9 81.0,91.6 80.3,91.6 79.6,91.6 78.9,90.3 78.2,91.6 77.6,91.6 76.9,98.5 76.2,113.7 75.5,92.9 74.8,101.1 74.1,110.0 73.4,72.5 72.8,113.0 72.1,144.0 71.4,157.9 70.7,163.9 70.0,167.8"/>
<polyline class="line" points="70.0,164.2 70.7,158.1 71.4,144.4 72.1,113.2 72.8,68.6 73.4,51.3 74.1,73.2 74.8,56.7 75.5,52.1 76.2,93.1 76.9,88.5 77.6,88.5 78.2,90.3 78.9,90.3 79.6,90.3 80.3,91.6 81.0,89.8 81.7,89.8 82.4,91.6 83.1,92.9 83.8,92.9 84.4,92.9 85.1,92.9 85.8,91.1 86.5,91.1 87.2,92.9 87.9,92.9 88.6,92.9 89.2,92.9 89.9,92.9 90.6,91.1 91.3,91.1 92.0,92.9 92.7,91.6 93.4,91.6 94.1,91.6 94.8,89.8 95.4,89.8 96.1,91.6 96.8,91.6 97.5,91.6 98.2,91.6 98.9,91.6 99.6,89.8 100.2,89.8 100.9,91.6 101.6,91.6 102.3,92.0 103.0,92.0 103.7,92.0 104.4,90.3 105.1,90.3 105.8,92.0 106.4,92.0 107.1,92.0 107.8,92.0 108.5,90.3 109.2,90.3 109.9,92.0 110.6,92.0 111.2,92.0 111.9,92.4 112.6,92.4 113.3,90.7 114.0,90.7 114.7,92.4 115.4,92.4 116.1,92.4 116.8,92.4 117.4,92.4 118.1,90.7 118.8,90.7 119.5,92.4 120.2,92.4 120.9,92.9 121.6,92.9 122.2,91.1 122.9,91.1 123.6,92.9 124.3,92.9 125.0,92.9 125.7,92.9 126.4,92.9 127.1,91.1 127.8,91.1 128.4,92.9 129.1,92.9 129.8,92.9 130.5,92.9 131.2,92.9 131.9,91.1 132.6,91.1 133.2,92.9 133.9,92.9 134.6,92.9 135.3,92.9 136.0,91.1 136.7,91.1 137.4,92.9 138.1,92.9 138.8,92.9 139.4,92.9 140.1,92.9 140.8,91.1 141.5,91.1 142.2,92.9 142.9,92.9 143.6,92.9 144.2,92.9 144.9,92.9 145.6,91.1 146.3,91.1 147.0,92.9 147.7,92.9 148.4,92.9 149.1,92.9 149.8,91.1 150.4,91.1 151.1,92.9 151.8,92.9 152.5,92.9 153.2,92.9 153.9,92.9 154.6,91.1 155.2,91.1 155.9,92.9 156.6,92.9 157.3,92.9 158.0,92.9 158.7,92.4 159.4,91.1 160.1,92.9 160.8,92.9 161.4,92.9 162.1,92.9 162.8,92.9 163.5,91.1 164.2,91.1 164.9,92.9 165.6,92.9 166.2,92.9 166.9,92.9 167.6,92.9 168.3,91.1 169.0,91.1 169.7,92.9 170.4,92.9 171.1,92.9 171.8,92.9 172.4,91.3 173.1,91.1 173.8,91.1 174.5,92.9 175.2,92.9 175.9,92.9 176.6,92.9 177.2,91.1 177.9,91.1 178.6,92.9 179.3,92.9 180.0,92.9 180.7,92.9 181.4,92.9 182.1,91.1 182.8,91.1 183.4,92.9 184.1,92.9 184.8,92.9 185.5,92.9 186.2,91.1 186.9,91.1 187.6,92.9 188.2,92.9 188.9,92.9 189.6,92.9 190.3,92.9 191.0,91.1 191.7,91.1 192.4,92.9 193.1,92.9 193.8,92.9 194.4,92.9 195.1,92.9 195.8,91.1 196.5,91.1 197.2,92.9 197.9,92.9 198.6,92.9 199.2,92.9 199.9,91.1 200.6,91.1 201.3,92.9 202.0,92.9 202.7,92.9 203.4,92.9 204.1,92.9 204.8,91.1 205.4,91.1 206.1,92.9 206.8,92.9 207.5,92.9 208.2,92.9 208.9,91.6 209.6,89.8 210.3,89.8 210.9,91.6 211.6,91.6 212.3,91.6 213.0,92.0 213.7,90.3 214.4,90.3 215.1,92.0 215.8,92.0 216.4,92.9 217.1,92.9 217.8,92.9 218.5,91.1 219.2,91.1 219.9,92.9 220.6,92.9 221.2,92.9 221.9,92.9 222.6,90.3 223.3,90.3 224.0,92.0 224.7,92.0 225.4,92.0 226.1,92.0 226.8,92.0 227.4,90.3 228.1,90.3 228.8,92.0 229.5,92.9 230.2,92.9 230.9,92.9 231.6,92.9 232.2,91.1 232.9,92.9 233.6,92.9 234.3,92.9 235.0,92.9 235.7,92.0 236.4,90.3 237.1,90.3 237.8,92.0 238.4,92.0 239.1,92.0 239.8,92.0 240.5,92.0 241.2,90.3 241.9,90.3 242.6,92.0 243.3,92.9 243.9,92.9 244.6,92.9 245.3,91.1 246.0,91.1 246.7,92.9 247.4,92.9 248.1,92.9 248.8,92.9 249.4,92.9 250.1,91.1 250.8,91.1 251.5,92.9 252.2,92.9 252.9,92.9 253.6,92.9 254.2,92.9 254.9,91.1 255.6,91.1 256.3,92.9 257.0,92.9 257.7,92.9 258.4,92.9 259.1,91.1 259.8,91.1 260.4,92.9 261.1,92.9 261.8,92.9 262.5,92.9 263.2,92.9 263.9,91.1 264.6,91.1 265.2,92.9 265.9,92.9 266.6,92.9 267.3,92.9 268.0,92.9 268.7,91.1 269.4,91.1 270.1,92.9 270.8,92.9 271.4,92.9 272.1,92.9 272.8,91.1 273.5,91.1 274.2,92.9 274.9,92.9 275.6,92.9 276.2,92.9 276.9,92.9 277.6,91.1 278.3,91.1 279.0,92.9 279.7,92.9 280.4,92.9 281.1,92.9 281.8,92.9 282.4,91.1 283.1,91.1 283.8,92.9 284.5,92.9 285.2,92.9 285.9,92.9 286.6,91.1 287.2,91.1 287.9,92.9 288.6,92.9 289.3,92.9 290.0,92.9 290.7,91.6 291.4,89.8 292.1,89.8 292.8,91.6 293.4,91.6 294.1,91.6 294.8,91.6 295.5,90.3 296.2,90.3 296.9,92.0 297.6,92.0 298.2,92.9 298.9,92.9 299.6,92.9 300.3,91.1 301.0,91.1 301.7,92.9 302.4,92.9 303.1,92.9 303.8,92.9 304.4,92.9 305.1,91.1 305.8,91.1 306.5,92.9 307.2,92.9 307.9,92.9 308.6,92.9 309.3,91.1 309.9,91.1 310.6,92.9 311.3,92.9 312.0,92.9 312.7,92.9 313.4,92.9 314.1,91.1 314.8,91.1 315.4,92.9 316.1,92.9 316.8,92.9 317.5,92.9 318.2,91.1 318.9,91.1 319.6,92.9 320.2,92.9 320.9,92.9 321.6,92.9 322.3,92.9 323.0,91.1 323.7,91.1 324.4,92.9 325.1,92.9 325.8,92.9 326.4,92.9 327.1,92.9 327.8,91.1 328.5,91.1 329.2,92.9 329.9,92.9 330.6,92.9 331.2,92.9 331.9,91.1 332.6,91.1 333.3,92.9 334.0,92.9 334.7,92.9 335.4,92.9 336.1,92.0 336.8,90.3 337.4,90.3 338.1,92.0 338.8,92.0 339.5,92.0 340.2,92.0 340.9,92.0 341.6,90.3 342.2,90.3 342.9,92.0 343.6,92.0 344.3,92.0 345.0,92.0 345.7,90.3 346.4,90.3 347.1,92.0 347.8,92.0 348.4,92.0 349.1,92.9 349.8,92.9 350.5,91.1 351.2,91.1 351.9,169.1 352.6,169.1 353.2,169.1 353.9,169.1 354.6,169.1 355.3,169.1 356.0,169.1 356.7,169.1 357.4,92.4 358.1,92.4 358.8,91.6 359.4,89.8 360.1,89.8 360.8,91.6 361.5,91.6 362.2,91.6 362.9,91.6 363.6,91.6 364.3,89.8 364.9,89.8 365.6,92.0 366.3,92.0 367.0,92.0 367.7,92.0 368.4,90.7 369.1,90.7 369.8,92.4 370.4,92.4 371.1,92.4 371.8,92.4 372.5,92.4 373.2,90.7 373.9,90.7 374.6,92.4 375.3,92.4 375.9,92.4 376.6,92.4 377.3,92.4 378.0,90.7 378.7,90.7 379.4,92.4 380.1,92.4 380.8,92.4 381.4,92.4 382.1,92.4 382.8,90.7 383.5,90.7 384.2,92.4 384.9,92.4 385.6,92.4 386.2,92.4 386.9,90.7 387.6,90.7 388.3,92.4 389.0,92.4 389.7,92.4 390.4,92.4 391.1,92.4 391.8,90.7 392.4,90.7 393.1,92.4 393.8,92.4 394.5,92.4 395.2,92.4 395.9,92.4 396.6,90.7 397.2,90.7 397.9,92.4 398.6,92.4 399.3,92.4 400.0,92.4 400.7,92.4 401.4,90.7 402.1,90.7 402.8,92.0 403.4,92.0 404.1,92.0 404.8,92.0 405.5,90.3 406.2,90.3 406.9,92.4 407.6,92.4 408.2,92.4 408.9,92.4 409.6,92.4 410.3,90.7 411.0,90.7 411.7,92.4 412.4,92.4 413.1,92.4 413.8,92.4 414.4,92.4 415.1,90.7 415.8,90.7 416.5,92.4 417.2,92.4 417.9,92.4 418.6,92.4 419.3,90.7 419.9,90.7 420.6,90.7 421.3,92.4 422.0,92.4 422.7,92.4 423.4,92.4 424.1,90.7 424.8,90.7 425.4,92.4 426.1,92.4 426.8,92.4 427.5,92.4 428.2,92.4 428.9,90.7 429.6,90.7 430.3,92.4 430.9,92.4 431.6,92.4 432.3,92.4 433.0,92.4 433.7,90.7 434.4,90.7 435.1,92.4 435.8,92.4 436.4,92.4 437.1,92.4 437.8,90.7 438.5,90.7 439.2,92.4 439.9,92.4 440.6,92.4 441.2,92.4 441.9,92.4 442.6,90.7 443.3,90.7 444.0,92.4 444.7,92.4 445.4,92.4 446.1,92.4 446.8,92.4 447.4,90.7 448.1,90.7 448.8,92.4 449.5,92.4 450.2,92.4 450.9,91.6 451.6,91.6 452.2,89.8 452.9,89.8 453.6,91.6 454.3,91.6 455.0,91.6 455.7,91.6 456.4,89.8 457.1,89.8 457.8,91.6 458.4,91.6 459.1,91.6 459.8,91.6 460.5,91.6 461.2,90.3 461.9,90.3 462.6,92.0 463.2,92.0 463.9,92.0 464.6,92.0 465.3,92.0 466.0,90.3 466.7,90.3 467.4,92.0 468.1,92.0 468.8,92.0 469.4,92.0 470.1,92.0 470.8,90.7 471.5,90.7 472.2,92.4 472.9,92.4 473.6,92.4 474.3,92.4 474.9,90.7 475.6,90.7 476.3,92.4 477.0,92.4 477.7,92.4 478.4,92.4 479.1,92.4 479.8,90.7 480.4,90.7 481.1,92.4 481.8,92.4 482.5,92.4 483.2,92.4 483.9,92.4 484.6,90.7 485.2,90.7 485.9,92.4 486.6,92.4 487.3,92.4 488.0,92.4 488.7,90.7 489.4,90.7 490.1,92.4 490.8,92.4 491.4,92.4 492.1,92.4 492.8,92.4 493.5,90.7 494.2,90.7 494.9,92.4 495.6,92.4 496.2,92.4 496.9,92.4 497.6,92.4 498.3,90.7 499.0,90.7 499.7,92.4 500.4,92.4 501.1,92.4 501.8,92.4 502.4,92.4 503.1,90.7 503.8,90.7 504.5,92.4 505.2,92.4 505.9,92.4 506.6,92.4 507.2,90.7 507.9,90.7 508.6,92.4 509.3,92.4 510.0,92.4 510.7,92.4 511.4,92.4 512.1,90.7 512.8,90.7 513.4,92.4 514.1,92.4 514.8,92.4 515.5,92.4 516.2,92.4 516.9,90.7 517.6,90.7 518.2,92.4 518.9,92.4 519.6,92.4 520.3,92.4 521.0,91.3 521.7,90.7 522.4,90.7 523.1,92.4 523.8,92.4 524.4,92.4 525.1,92.4 525.8,90.7 526.5,90.7 527.2,92.4 527.9,92.4 528.6,92.4 529.2,92.4 529.9,92.4 530.6,90.7 531.3,90.7 532.0,92.4 532.7,92.4 533.4,92.4 534.1,92.4 534.8,92.4 535.4,90.7 536.1,90.7 536.8,92.4 537.5,92.4 538.2,92.4 538.9,92.4 539.6,90.7 540.2,90.7 540.9,92.4 541.6,92.4 542.3,92.4 543.0,92.4 543.7,92.4 544.4,90.7 545.1,90.7 545.8,90.7 546.4,90.7 547.1,90.7 547.8,90.7 548.5,90.7 549.2,89.0 549.9,89.0 550.6,90.7 551.2,90.7 551.9,90.7 552.6,90.7 553.3,90.7 554.0,89.0 554.7,89.0 555.4,90.7 556.1,90.7 556.8,91.1 557.4,91.1 558.1,89.4 558.8,89.4 559.5,91.1 560.2,91.1 560.9,91.1 561.6,91.1 562.3,91.1 562.9,89.4 563.6,89.4 564.3,91.1 565.0,91.1 565.7,91.1 566.4,91.1 567.1,91.1 567.8,89.4 568.4,89.4 569.1,91.1 569.8,91.1 570.5,91.1 571.2,91.1 571.9,91.1 572.6,89.8 573.2,89.8 573.9,91.6 574.6,91.6 575.3,91.6 576.0,91.6 576.7,89.8 577.4,89.8 578.1,91.6 578.8,91.6 579.4,91.6 580.1,91.6 580.8,91.6 581.5,90.7 582.2,90.7 582.9,92.0 583.6,92.0 584.2,92.0 584.9,92.0 585.6,92.0 586.3,90.3 587.0,90.3 587.7,90.7 588.4,90.7 589.1,90.7 589.8,90.7 590.4,89.0 591.1,89.0 591.8,91.1 592.5,91.1 593.2,91.1 593.9,91.1 594.6,92.0 595.2,90.7 595.9,90.7 596.6,92.4 597.3,92.4 598.0,92.4 598.7,92.4 599.4,92.4 600.1,90.7 600.8,90.7 601.4,92.4 602.1,92.4 602.8,92.4 603.5,92.4 604.2,90.7 604.9,90.7 605.6,92.4 606.2,92.4 606.9,92.4 607.6,92.4 608.3,92.4 609.0,90.7 609.7,90.7 610.4,92.0 611.1,92.0 611.8,91.6 612.4,90.7 613.1,90.7 613.8,89.0 614.5,89.0 615.2,90.7 615.9,90.7 616.6,90.7 617.3,91.1 617.9,91.1 618.6,89.4 619.3,89.4"/>
<line class="grid" x1="70" y1="170.0" x2="620" y2="170.0"/>
<text class="muted small" x="64" y="174.0" text-anchor="end">0</text>
<line class="grid" x1="70" y1="126.7" x2="620" y2="126.7"/>
<text class="muted small" x="64" y="130.7" text-anchor="end">200</text>
<line class="grid" x1="70" y1="83.3" x2="620" y2="83.3"/>
<text class="muted small" x="64" y="87.3" text-anchor="end">400</text>
<line class="grid" x1="70" y1="40.0" x2="620" y2="40.0"/>
<text class="muted small" x="64" y="44.0" text-anchor="end">600</text>
<text class="muted small" x="70.0" y="186" text-anchor="middle">0s</text>
<text class="muted small" x="207.5" y="186" text-anchor="middle">5s</text>
<text class="muted small" x="345.0" y="186" text-anchor="middle">10s</text>
<text class="muted small" x="482.5" y="186" text-anchor="middle">15s</text>
<text class="muted small" x="620.0" y="186" text-anchor="middle">20s</text>
<text class="small strong" x="70" y="26">cwnd, packets - the whole 20s run</text>
<text class="small" x="82.4" y="55.3">← Startup: all 528 retransmits of the run</text>
<path class="note" d="M353.7,165.7 L381.7,148.3"/>
<text class="small" x="385.7" y="152.3">ProbeRTT: 4 packets for 227ms</text>
<line class="grid" x1="70" y1="337.5" x2="620" y2="337.5"/>
<text class="muted small" x="64" y="341.5" text-anchor="end">20ms</text>
<line class="grid" x1="70" y1="291.4" x2="620" y2="291.4"/>
<text class="muted small" x="64" y="295.4" text-anchor="end">25ms</text>
<line class="grid" x1="70" y1="245.2" x2="620" y2="245.2"/>
<text class="muted small" x="64" y="249.2" text-anchor="end">30ms</text>
<polyline class="line" points="70.1,312.6 71.3,313.2 72.5,313.4 73.8,312.9 75.0,313.4 76.2,313.6 77.4,313.5 78.5,313.3 79.7,313.8 80.9,314.0 82.2,313.5 83.4,314.1 84.6,314.3 86.0,313.8 87.2,314.4 88.4,314.6 89.7,314.1 90.9,314.6 92.1,314.8 93.4,314.5 94.6,314.9 95.8,315.1 97.2,314.7 98.4,315.2 99.6,315.4 100.9,315.0 102.1,315.5 103.3,315.6 104.6,315.2 105.8,315.8 107.0,315.9 108.4,315.6 109.6,316.1 110.7,316.3 112.1,315.8 113.3,316.4 114.5,316.6 115.8,316.1 117.0,316.6 118.2,316.9 119.6,316.4 120.7,317.0 121.9,317.1 123.3,316.8 124.5,317.2 125.7,317.4 127.0,317.0 128.2,317.5 129.4,317.7 130.7,317.3 131.9,317.8 133.1,318.0 134.5,317.6 135.7,318.2 136.9,318.3 138.2,317.9 139.4,318.4 140.6,318.6 141.9,318.2 143.1,318.7 144.3,318.9 145.7,318.4 146.9,319.0 148.0,319.2 149.4,318.8 150.6,319.3 151.8,319.4 153.0,319.4 154.3,318.9 155.6,319.4 157.0,319.4 158.3,319.4 159.6,318.9 161.0,319.4 162.3,319.5 163.6,319.4 165.0,319.1 166.3,319.5 167.6,319.7 169.0,319.5 170.1,319.5 171.4,319.2 172.7,319.6 174.0,319.8 175.4,319.7 176.7,319.3 178.0,319.7 179.4,319.9 180.7,319.8 182.0,318.6 183.4,317.0 184.7,315.0 186.0,313.0 187.4,310.9 188.7,308.6 190.0,306.5 191.3,304.3 192.7,302.1 194.0,299.9 195.3,297.7 196.7,295.4 198.0,293.1 199.3,291.0 200.7,288.8 202.0,286.6 203.3,284.5 204.7,282.2 206.0,280.0 207.3,277.8 208.7,275.6 210.0,273.4 211.3,271.2 212.7,269.0 214.0,266.7 215.3,264.5 216.7,265.8 218.0,268.1 219.3,270.7 220.7,274.5 222.0,278.1 223.3,281.3 224.7,285.4 226.0,289.2 227.3,292.5 228.7,296.6 230.0,300.4 231.3,303.8 232.7,305.2 234.0,306.6 235.3,307.2 236.6,307.4 238.0,307.1 239.3,307.6 240.6,307.8 242.0,307.7 243.3,307.4 244.6,307.8 246.0,308.0 247.3,307.8 248.6,307.4 249.7,307.4 251.0,308.0 252.4,308.2 253.7,308.0 255.0,307.6 256.4,308.1 257.7,308.3 259.0,308.1 260.4,307.6 261.7,308.2 263.0,308.4 264.4,308.2 265.7,307.8 267.0,308.3 268.4,308.5 269.7,308.4 271.0,307.9 272.4,308.5 273.7,308.6 275.0,308.5 276.4,308.1 277.7,308.6 279.0,308.7 280.3,308.6 281.7,308.2 283.0,308.6 284.3,308.8 285.7,308.7 287.0,308.3 288.3,308.8 289.7,308.9 291.0,308.8 292.3,308.5 293.7,308.9 295.0,309.1 296.3,308.9 297.7,308.6 299.0,309.0 300.3,309.2 301.7,309.1 303.0,308.7 304.3,309.2 305.7,309.4 307.0,309.2 308.3,308.7 309.7,309.3 311.0,309.4 312.3,309.3 313.7,308.9 315.0,309.4 316.3,309.6 317.7,309.4 319.0,309.0 320.3,309.5 321.7,309.7 323.0,309.5 324.3,309.1 325.6,309.7 327.0,309.8 328.3,309.7 329.6,309.2 331.0,309.8 332.3,309.8 333.6,309.8 335.0,309.3 336.3,309.8 337.6,310.0 339.0,309.8 340.3,309.5 341.6,309.9 343.0,310.1 344.3,309.9 345.6,309.6 347.0,310.0 348.3,310.2 349.6,310.1 351.0,309.7 352.3,310.2 353.6,310.4 355.0,310.3 356.3,309.8 357.6,310.3 359.0,310.5 360.3,310.3 361.6,309.9 363.0,310.5 364.3,310.6 365.6,309.7 366.9,308.1 368.3,306.2 369.6,304.1 370.9,302.0 372.3,299.8 373.6,297.6 374.9,295.4 376.3,293.2 377.6,291.0 378.9,288.8 380.3,286.6 381.6,284.4 382.9,282.2 384.3,279.9 385.6,277.7 386.9,275.5 388.3,273.3 389.6,271.1 390.9,268.9 392.3,266.6 393.6,264.4 394.9,265.0 396.3,266.6 397.6,270.0 398.9,273.3 400.3,276.4 401.6,280.5 402.9,284.2 404.3,287.5 405.6,291.7 407.0,295.4 408.2,298.8 409.6,302.9 410.9,304.9 412.3,305.5 413.6,306.5 414.9,307.0 416.2,307.0 417.6,306.6 418.9,307.2 420.2,307.4 421.6,307.2 422.9,306.8 424.2,307.4 425.6,307.4 426.9,307.4 428.2,306.9 429.6,307.4 430.9,307.6 432.2,307.4 433.6,307.1 434.9,307.5 436.1,307.8 437.4,307.4 438.6,308.0 439.8,308.2 441.2,307.8 442.4,308.3 443.6,308.6 444.9,308.1 446.1,308.6 447.3,308.7 448.6,308.4 449.8,308.8 451.0,309.0 452.3,308.6 453.6,309.2 454.7,309.4 456.1,308.9 457.3,309.5 458.5,309.7 459.8,309.2 461.0,309.8 462.2,309.9 463.5,309.5 464.7,309.9 465.9,310.2 467.3,309.8 468.5,310.3 469.7,310.5 471.0,310.0 472.2,310.6 473.4,310.8 474.7,310.3 475.9,310.9 477.1,311.0 478.5,310.6 479.7,311.1 480.9,311.3 482.2,310.9 483.4,311.4 484.6,311.6 485.9,311.2 487.1,311.7 488.3,311.9 489.7,311.4 490.9,312.0 492.1,312.2 493.4,311.7 494.6,312.2 495.8,312.4 497.1,312.0 498.3,312.5 499.5,312.6 500.8,312.2 502.1,312.8 503.2,313.0 504.6,312.5 505.8,313.1 507.0,313.3 508.3,312.8 509.5,313.4 510.7,313.5 512.0,313.1 513.2,313.6 514.4,313.8 515.8,313.4 517.0,313.9 518.2,314.1 519.5,313.7 520.7,314.2 521.9,314.4 523.2,314.0 524.4,314.5 525.6,314.6 527.0,314.3 528.2,314.8 529.4,315.0 530.7,314.6 531.9,315.1 533.1,315.3 534.4,314.8 535.6,315.4 536.8,315.6 538.2,315.2 539.4,315.7 540.6,315.9 541.8,315.8 543.0,314.7 544.1,313.3 545.4,311.6 546.6,309.8 547.7,307.9 548.9,306.0 550.1,304.0 551.3,302.1 552.5,300.2 553.7,298.2 554.9,296.4 556.1,294.3 557.3,292.4 558.5,290.6 559.7,288.6 560.9,286.7 562.1,284.6 563.3,282.8 564.5,280.9 565.7,278.9 566.9,277.0 568.1,275.0 569.3,273.1 570.5,271.2 571.7,269.2 573.1,267.8 574.4,269.4 575.7,272.3 577.1,275.7 578.4,279.3 579.7,283.1 581.1,287.0 582.4,290.8 583.7,294.6 585.1,298.5 586.4,302.4 587.7,306.2 589.1,309.0 590.3,310.8 591.4,311.6 592.8,311.5 594.0,312.2 595.2,312.5 596.5,312.2 597.7,312.6 598.9,312.8 600.2,312.4 601.4,313.0 602.6,313.2 604.0,312.7 605.2,313.3 606.4,313.4 607.7,313.0 608.9,313.5 610.1,313.7 611.4,313.3 612.6,313.8 613.8,314.0 615.2,313.6 616.4,314.1 617.6,314.3 618.9,313.9"/>
<text class="muted small" x="70.0" y="372" text-anchor="middle">5.0s</text>
<text class="muted small" x="180.0" y="372" text-anchor="middle">5.1s</text>
<text class="muted small" x="290.0" y="372" text-anchor="middle">5.2s</text>
<text class="muted small" x="400.0" y="372" text-anchor="middle">5.3s</text>
<text class="muted small" x="510.0" y="372" text-anchor="middle">5.4s</text>
<text class="muted small" x="620.0" y="372" text-anchor="middle">5.5s</text>
<text class="small strong" x="70" y="222">smoothed RTT - half a second of ProbeBW</text>
<path class="note" d="M213.0,252.6 L213.0,247.1 L389.0,247.1 L389.0,252.6"/>
<text class="small" x="301.0" y="241.1" text-anchor="middle">8 round trips</text>
<text class="small" x="411.0" y="243.4">each peak: a 1.25 round builds</text>
<text class="small" x="411.0" y="258.4">a little queue, a 0.75 round drains it</text>
</svg>
</figure>

All 528 came in the first 0.3 seconds. Startup's 2.89 gain doubles the
sending rate every round trip, as slow start does, and overshoots the
same way: by the time the bandwidth estimate has stopped growing for
three round trips, cwnd has reached 548 packets, on a path that holds
about 282. After that, nothing - 19.7 seconds without a single
retransmit. The probe cycle keeps running every 160ms, but each 1.25
round builds only a few milliseconds of queue, and the 0.75 round after
it drains it again, so the queue never gets near its limit.

The dip at 10.2 seconds is ProbeRTT. The minimum RTT hadn't been
refreshed for ten seconds, so BBR cut itself to four packets in flight
for 227ms, long enough for the queue to drain completely and the true
round trip to show. For those 227ms the link is nearly idle: a little
over 2% of every ten seconds, the price of keeping the model honest.

For a single flow, that's a cheap trade for 93Mbit/s through 1% loss.
The more interesting question is what happens to everything else on the
link.

## Sharing a link

Two flows started together, sharing the bottleneck for 60 seconds, with
no random loss. The queue varies: half a BDP, one BDP and four BDPs of
actual queue.

| queue   | flows        | Mbit/s      | share     | retransmits     | queue, ms |
|---------|--------------|-------------|-----------|-----------------|----------:|
| 0.5 BDP | cubic, cubic | 48.2 / 47.4 | 50 / 50%  | 45 / 36         |       6.3 |
| 0.5 BDP | bbr, bbr     | 46.9 / 46.9 | 50 / 50%  | 15,461 / 16,749 |       8.5 |
| 0.5 BDP | cubic, bbr   | 9.6 / 84.5  | 10 / 90%  | 446 / 4,040     |       5.7 |
| 1 BDP   | cubic, cubic | 42.9 / 52.7 | 45 / 55%  | 30 / 30         |      15.8 |
| 1 BDP   | bbr, bbr     | 48.4 / 45.5 | 52 / 48%  | 14,096 / 14,755 |      18.6 |
| 1 BDP   | cubic, bbr   | 10.3 / 83.8 | 11 / 89%  | 268 / 2,182     |      14.4 |
| 4 BDP   | cubic, cubic | 44.0 / 51.7 | 46 / 54%  | 40 / 34         |      68.3 |
| 4 BDP   | bbr, bbr     | 43.4 / 50.6 | 46 / 54%  | 0 / 0           |      24.7 |
| 4 BDP   | cubic, bbr   | 57.8 / 37.8 | 60 / 40%  | 236 / 235       |      55.7 |

Two cubic flows share about evenly at every queue size, and fill
whatever queue they're given: 6ms of queueing delay with half a BDP of
buffer, 68ms with four.

BBR against cubic depends on the buffer. In a shallow one, BBR takes
90% of the link. Cubic keeps running into the full queue and halving its
window; BBR runs into the same full queue and doesn't react. In a deep
one it's the other way round, and cubic gets 60%. BBR caps its data in
flight at twice its BDP estimate, while cubic keeps growing until a
queue four BDPs deep overflows - and most of what sits in that queue is
cubic's.

Two BBR flows are fair to each other, but not always quiet. With four
BDPs of queue they behave as designed: no retransmits at all, and about
one BDP of standing queue, a third of what two cubic flows keep. With
half a BDP or one BDP of queue, the same two flows retransmitted 14,000
to 17,000 packets each in a minute - between 5 and 7% of everything they
sent - and kept the queue as full as cubic does, or fuller. Each flow's bandwidth
estimate is a maximum over the last few round trips, which includes
moments when the other flow had just backed off to drain. Together they
overestimate the link, send faster than it can drain, and end up
limited by their in-flight caps instead of their pacing rate: about two
BDPs between them. A path with half a BDP of queue can't hold that, and
one with a full BDP of queue holds it only just.
The excess is dropped, continuously, and since BBRv1 doesn't treat loss
as a signal, nothing makes either flow slow down. This is the behaviour
Hock, Bless and Zitterbart describe for BBRv1 in shallow buffers.

## So, what

BBR replaces "a loss means the path is full" with a model of the path,
measured continuously: the fastest it has delivered, and the shortest
round trip it has seen. On a link with random loss, that's the
difference between 6 and 93Mbit/s. On a clean link, it keeps a smaller
queue than the loss-based algorithms, which helps every latency-sensitive
flow sharing the bottleneck.

On its own, it pays little for that: a burst of drops at Startup and
a 200ms pause every ten seconds. Shared, BBRv1 is less tidy. It crowds
cubic out of a shallow buffer and loses to it in a deep one, and two BBR
flows over a shallow buffer lose several percent of their packets
without slowing down. Reno's rule - back off when something is lost -
says nothing about the path, but every flow backs off the same way. BBR's
model is about the path alone, not about who else is using it. That's
the gap BBRv2 and v3 close, by letting loss and ECN back in as signals.

## References

- N. Cardwell, Y. Cheng, C. S. Gunn, S. Hassas Yeganeh, V. Jacobson, [BBR: Congestion-Based Congestion Control](https://queue.acm.org/detail.cfm?id=3022184), ACM Queue (2016) - the model, the states and the gains
- [net/ipv4/tcp_bbr.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/net/ipv4/tcp_bbr.c) - BBRv1 in Linux, with a long comment describing the state machine
- M. Hock, R. Bless, M. Zitterbart, [Experimental Evaluation of BBR Congestion Control](https://doi.org/10.1109/ICNP.2017.8117540), ICNP (2017) - BBRv1 with multiple flows, shallow buffers and cubic
- [google/bbr](https://github.com/google/bbr) - BBRv3, out of tree
- [darfire/bloggy-code - tcp-loss](https://github.com/darfire/bloggy-code/tree/main/tcp-loss) - the test program, namespace setup and `bench.sh`
