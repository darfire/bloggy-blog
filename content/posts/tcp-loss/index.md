+++
title = 'What a Lost Packet Costs: Reno and Cubic'
date = 2026-11-11T09:00:00Z
draft = false
summary = "One percent packet loss turns a 100Mbit link into a 6Mbit one. Why TCP's loss-based congestion control pays that much, measured on Linux, checked against a forty-year-old formula, and modelled in a small simulator you can play with."
tags = ['networking', 'TCP', 'performance']
+++

TCP promises an ordered, reliable byte stream. When a packet goes
missing, the application never finds out: the kernel notices, sends the
packet again, and hands the bytes over in order as if nothing had
happened. What the kernel can't hide is the cost. On the test link in
this post - 100Mbit, 20ms round trip - dropping one packet in a hundred
at random brings a bulk transfer down from 95Mbit/s to about 6Mbit/s.
That's 94% of the throughput gone to lose 1% of the packets.

This post is about where that cost comes from. Most of it isn't the
retransmissions themselves. It's what the congestion control algorithm
decides to do once it has seen a loss.

## What the sender is allowed to have in flight

A TCP sender can't put an unlimited amount of data on the wire. At any
moment it may have at most *cwnd* (congestion window) packets sent but
not yet acknowledged.

Picture the stream as a numbered row of packets. Everything left of the
window has been acknowledged, the window covers the packets in flight,
and everything to its right is waiting. The receiver acknowledges
packets as they arrive (in practice, usually every second one). Each ACK
that comes back moves the window's left edge forward, and the sender may
send whatever has just entered it on the right. So after the first round
trip, it isn't the sender that decides when to send - the returning ACKs
do. Packets leave at the pace ACKs come back, which is known as ACK
clocking, and one window's worth goes out per round trip.

<figure class="tl-window">
<style>
.tl-window svg { display: block; width: 100%; max-width: 680px; height: auto; margin: 0 auto; }
.tl-window text { fill: currentColor; font: 13px system-ui, sans-serif; }
.tl-window .title { font-weight: 600; font-size: 14px; }
.tl-window .muted { opacity: 0.7; }
.tl-window .small { font-size: 12px; }
.tl-window .strong { font-weight: 600; }
.tl-window .acked { fill: rgba(var(--color-neutral-500), 0.18); stroke: rgb(var(--color-neutral-400)); stroke-width: 1; }
.tl-window .flight { fill: rgb(var(--color-primary-600)); }
.tl-window .wait { fill: none; stroke: rgb(var(--color-neutral-400)); stroke-width: 1; }
.tl-window .num-flight { fill: #ffffff; }
.tl-window .num-acked { opacity: 0.6; }
.tl-window .brk { fill: none; stroke: currentColor; stroke-width: 1.5; }
.tl-window .brk-next { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-dasharray: 4 3; opacity: 0.7; }
.tl-window .sep { stroke: rgb(var(--color-neutral-400)); stroke-width: 1; stroke-dasharray: 2 4; }
.tl-window .axis { stroke: rgb(var(--color-neutral-400)); stroke-width: 2; }
.tl-window .data { stroke: rgb(var(--color-primary-600)); stroke-width: 1.75; }
.tl-window .ack { stroke: rgb(var(--color-neutral-500)); stroke-width: 1.5; stroke-dasharray: 5 3; }
.dark .tl-window .flight { fill: rgb(var(--color-primary-500)); }
.dark .tl-window .data { stroke: rgb(var(--color-primary-400)); }
.dark .tl-window .ack { stroke: rgb(var(--color-neutral-400)); }
</style>
<svg viewBox="0 0 640 402" role="img" aria-labelledby="tl-window-title">
<title id="tl-window-title">Top: the stream as numbered packets. 1 to 4 are acknowledged, 5 to 8 are in flight (cwnd = 4), 9 onwards are not sent yet; when the ACK for 5 returns, the window slides one place and 9 can be sent. Bottom: a time diagram between sender and receiver. The sender sends 5 to 8, the receiver acknowledges each on arrival, and each ACK that reaches the sender releases one new packet, 9 to 12, so one window goes out per round trip.</title>
<rect class="acked" x="46" y="52" width="30" height="24" rx="3"/>
<text class="small num-acked" x="61" y="68" text-anchor="middle">1</text>
<rect class="acked" x="80" y="52" width="30" height="24" rx="3"/>
<text class="small num-acked" x="95" y="68" text-anchor="middle">2</text>
<rect class="acked" x="114" y="52" width="30" height="24" rx="3"/>
<text class="small num-acked" x="129" y="68" text-anchor="middle">3</text>
<rect class="acked" x="148" y="52" width="30" height="24" rx="3"/>
<text class="small num-acked" x="163" y="68" text-anchor="middle">4</text>
<rect class="flight" x="182" y="52" width="30" height="24" rx="3"/>
<text class="small num-flight" x="197" y="68" text-anchor="middle">5</text>
<rect class="flight" x="216" y="52" width="30" height="24" rx="3"/>
<text class="small num-flight" x="231" y="68" text-anchor="middle">6</text>
<rect class="flight" x="250" y="52" width="30" height="24" rx="3"/>
<text class="small num-flight" x="265" y="68" text-anchor="middle">7</text>
<rect class="flight" x="284" y="52" width="30" height="24" rx="3"/>
<text class="small num-flight" x="299" y="68" text-anchor="middle">8</text>
<rect class="wait" x="318" y="52" width="30" height="24" rx="3"/>
<text class="small num-wait" x="333" y="68" text-anchor="middle">9</text>
<rect class="wait" x="352" y="52" width="30" height="24" rx="3"/>
<text class="small num-wait" x="367" y="68" text-anchor="middle">10</text>
<rect class="wait" x="386" y="52" width="30" height="24" rx="3"/>
<text class="small num-wait" x="401" y="68" text-anchor="middle">11</text>
<rect class="wait" x="420" y="52" width="30" height="24" rx="3"/>
<text class="small num-wait" x="435" y="68" text-anchor="middle">12</text>
<rect class="wait" x="454" y="52" width="30" height="24" rx="3"/>
<text class="small num-wait" x="469" y="68" text-anchor="middle">13</text>
<rect class="wait" x="488" y="52" width="30" height="24" rx="3"/>
<text class="small num-wait" x="503" y="68" text-anchor="middle">14</text>
<rect class="wait" x="522" y="52" width="30" height="24" rx="3"/>
<text class="small num-wait" x="537" y="68" text-anchor="middle">15</text>
<rect class="wait" x="556" y="52" width="30" height="24" rx="3"/>
<text class="small num-wait" x="571" y="68" text-anchor="middle">16</text>
<text class="muted small" x="112" y="40" text-anchor="middle">acknowledged</text>
<path class="brk" d="M182,50 L182,44 L314,44 L314,50"/>
<text class="small strong" x="248" y="36" text-anchor="middle">in flight: cwnd = 4</text>
<text class="muted small" x="452" y="40" text-anchor="middle">not sent yet</text>
<path class="brk-next" d="M216,78 L216,84 L348,84 L348,78"/>
<text class="muted small" x="282" y="100" text-anchor="middle">after the ACK for 5 comes back: 9 can go</text>
<line class="sep" x1="20" y1="118" x2="620" y2="118"/>
<text class="title" x="200" y="140" text-anchor="middle">sender</text>
<text class="title" x="520" y="140" text-anchor="middle">receiver</text>
<line class="axis" x1="200" y1="146" x2="200" y2="364"/>
<line class="axis" x1="520" y1="146" x2="520" y2="364"/>
<text class="muted small" x="528" y="364">time ↓</text>
<line class="data" x1="200" y1="150" x2="520" y2="200"/>
<text class="small" x="528" y="204">5</text>
<line class="ack" x1="520" y1="200" x2="200" y2="250"/>
<line class="data" x1="200" y1="250" x2="520" y2="300"/>
<text class="small" x="528" y="304">9</text>
<line class="data" x1="200" y1="162" x2="520" y2="212"/>
<text class="small" x="528" y="216">6</text>
<line class="ack" x1="520" y1="212" x2="200" y2="262"/>
<line class="data" x1="200" y1="262" x2="520" y2="312"/>
<text class="small" x="528" y="316">10</text>
<line class="data" x1="200" y1="174" x2="520" y2="224"/>
<text class="small" x="528" y="228">7</text>
<line class="ack" x1="520" y1="224" x2="200" y2="274"/>
<line class="data" x1="200" y1="274" x2="520" y2="324"/>
<text class="small" x="528" y="328">11</text>
<line class="data" x1="200" y1="186" x2="520" y2="236"/>
<text class="small" x="528" y="240">8</text>
<line class="ack" x1="520" y1="236" x2="200" y2="286"/>
<line class="data" x1="200" y1="286" x2="520" y2="336"/>
<text class="small" x="528" y="340">12</text>
<path class="brk" d="M190,150 L184,150 L184,250 L190,250"/>
<text class="small" x="176" y="198" text-anchor="end">one round trip:</text>
<text class="small" x="176" y="214" text-anchor="end">cwnd packets</text>
<text class="muted small" x="176" y="276" text-anchor="end">each ACK that</text>
<text class="muted small" x="176" y="291" text-anchor="end">arrives lets one</text>
<text class="muted small" x="176" y="306" text-anchor="end">more packet out</text>
<line class="data" x1="250" y1="386" x2="276" y2="386"/>
<text class="muted small" x="282" y="390">data</text>
<line class="ack" x1="340" y1="386" x2="366" y2="386"/>
<text class="muted small" x="372" y="390">ACK</text>
</svg>
</figure>

So, roughly, a connection moves one cwnd per round trip:

$$
\text{throughput} \approx \frac{\text{cwnd} \times \text{MSS}}{\text{RTT}}
$$

On the test link a segment carries 1448 bytes of payload (MSS) and the
round trip is 20ms, so filling 100Mbit/s takes a cwnd of about 165
packets. That number - the link rate times the round trip, in packets -
is the bandwidth-delay product (BDP), and it comes up throughout this
post. With cwnd below the BDP the link sits idle part of the time. Above
it, the extra packets have nowhere to go but the queue at the
bottleneck, where they wait and add delay; once the queue is full, they
are dropped.

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

The sender doesn't know the BDP. It has to find it, and keep finding it
as other traffic comes and goes. That search is the job of the
congestion control algorithm (CC), and on Linux it's a pluggable module:
`reno`, `cubic` (the default) and `bbr` are three of them, selectable per
socket with `setsockopt(TCP_CONGESTION)`.

One detail about Linux is worth knowing up front. The CC module only
decides how big cwnd should be: how fast it grows, and what it drops to
after a loss. Detecting and repairing losses - SACK, RACK, tail loss
probes, retransmission timeouts - is done by the TCP stack itself, the
same way for every CC. So "reno" in this post means Reno's rules for the
window on top of a modern loss-recovery machine, not the 1990 code.

## Reno

Reno is named after the 4.3BSD-Reno release from 1990, and it builds on
Van Jacobson's 1988 work, written after the congestion collapses of the
mid-1980s. Almost every later algorithm is described as a change to it.
Its rules for the window:

- **Slow start.** A new connection starts with a cwnd of 10 packets and
  adds one for every packet acknowledged, which doubles cwnd every round
  trip. Despite the name, it's the fast part.
- **Congestion avoidance.** Once past a threshold (*ssthresh*), cwnd
  grows by one packet per round trip.
- **On loss, halve.** A loss is taken to mean the queue at the
  bottleneck overflowed, i.e. the sender has found the limit. Reno sets
  ssthresh to half of cwnd and continues from there.

Grow by one, cut in half: additive increase, multiplicative decrease
(AIMD). With nothing else on the link, it draws a sawtooth. cwnd climbs
until the queue overflows, falls to half, and climbs again.

## Cubic

Reno's one packet per round trip is fine at 100Mbit and 20ms, where the
sawtooth is about 140 packets tall and takes under four seconds to climb.
On a 10Gbit path across an ocean, the same climb is thousands of round
trips long and takes over an hour. Cubic, Linux's default since 2006,
changes two things:

- **It cuts less.** On loss, cwnd drops to 0.7 of itself, not 0.5.
- **It grows by time, not by round trips.** After a loss, cwnd follows a
  cubic curve in the time since the loss: quickly back towards the window
  where the loss happened, flat around it, then increasingly fast past
  it, probing for more. The curve's shape doesn't depend on the RTT, so
  long paths recover as fast as short ones.

Cubic also keeps a running estimate of what Reno would have reached in
the same time, and never grows more slowly than that (the "Reno-friendly
region"). On short paths with small windows the cubic curve is very slow,
and this estimate is what actually drives the growth. Keep that in mind
for the measurements below: on this link, cubic is often Reno with
different constants.

Linux's cubic also comes with HyStart, which watches the ACKs during
slow start and leaves it early when it sees the round trip time rising
or the ACKs spreading out - the signs of a queue starting to form -
instead of doubling until something is dropped. That turns out to
matter.

## The setup

Everything runs on one machine, inside one kernel: a client and a server
in their own network namespaces, with a third namespace between them as
a router, connected by virtual Ethernet pairs. On the router's outgoing
interfaces, `netem` adds 10ms of delay in each direction, limits the
data direction to 100Mbit, and drops a set percentage of data packets at
random. Both ends are the kernel's own TCP stack. The program on top
just writes as fast as it can and reports what the receiver got.

<figure class="tl-setup">
<style>
.tl-setup svg { display: block; width: 100%; max-width: 680px; height: auto; margin: 0 auto; }
.tl-setup text { fill: currentColor; font: 13px system-ui, sans-serif; }
.tl-setup .title { font-weight: 600; font-size: 14px; }
.tl-setup .muted { opacity: 0.7; }
.tl-setup .small { font-size: 12px; }
.tl-setup .frame { fill: none; stroke: rgb(var(--color-neutral-400)); stroke-width: 1; stroke-dasharray: 6 5; }
.tl-setup .box { fill: rgba(var(--color-neutral-500), 0.06); stroke: rgb(var(--color-neutral-400)); stroke-width: 1.5; }
.tl-setup .netem { fill: rgba(var(--color-primary-600), 0.12); stroke: rgb(var(--color-primary-600)); stroke-width: 1.5; }
.tl-setup .data { stroke: rgb(var(--color-primary-600)); stroke-width: 2; fill: none; }
.tl-setup .data-head { fill: rgb(var(--color-primary-600)); }
.tl-setup .ack { stroke: rgb(var(--color-neutral-500)); stroke-width: 2; fill: none; }
.tl-setup .ack-head { fill: rgb(var(--color-neutral-500)); }
.dark .tl-setup .netem { fill: rgba(var(--color-primary-400), 0.15); stroke: rgb(var(--color-primary-400)); }
.dark .tl-setup .data { stroke: rgb(var(--color-primary-400)); }
.dark .tl-setup .data-head { fill: rgb(var(--color-primary-400)); }
.dark .tl-setup .ack { stroke: rgb(var(--color-neutral-400)); }
.dark .tl-setup .ack-head { fill: rgb(var(--color-neutral-400)); }
</style>
<svg viewBox="0 0 640 352" role="img" aria-labelledby="tl-setup-title">
<title id="tl-setup-title">Client, router and server network namespaces in one Linux kernel, joined by veth pairs. netem on the router's egress adds delay, a 100Mbit rate limit and random loss to the data direction, and delay to the ACK direction.</title>
<defs>
<marker id="tl-data-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="data-head" d="M0,0 L10,5 L0,10 z"/></marker>
<marker id="tl-ack-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ack-head" d="M0,0 L10,5 L0,10 z"/></marker>
</defs>
<rect class="frame" x="8" y="8" width="624" height="252" rx="12"/>
<text class="muted small" x="22" y="30">one Linux kernel, offloads off on every interface</text>
<rect class="box" x="28" y="48" width="140" height="196" rx="8"/>
<text class="title" x="98" y="72" text-anchor="middle">client</text>
<text class="muted small" x="98" y="91" text-anchor="middle">netns tl-a</text>
<text class="small" x="98" y="108" text-anchor="middle">10.99.1.1</text>
<text class="small" x="98" y="232" text-anchor="middle">tcploss bulk / rr</text>
<text class="muted small" x="160" y="128" text-anchor="end">va</text>
<rect class="box" x="250" y="48" width="140" height="196" rx="8"/>
<text class="title" x="320" y="72" text-anchor="middle">router</text>
<text class="muted small" x="320" y="91" text-anchor="middle">netns tl-r</text>
<text class="small" x="320" y="108" text-anchor="middle">forwards only</text>
<text class="muted small" x="258" y="128">ra</text>
<text class="muted small" x="382" y="128" text-anchor="end">rb</text>
<rect class="box" x="472" y="48" width="140" height="196" rx="8"/>
<text class="title" x="542" y="72" text-anchor="middle">server</text>
<text class="muted small" x="542" y="91" text-anchor="middle">netns tl-b</text>
<text class="small" x="542" y="108" text-anchor="middle">10.99.2.1</text>
<text class="small" x="542" y="232" text-anchor="middle">tcploss server</text>
<text class="muted small" x="480" y="128">vb</text>
<line class="data" x1="168" y1="146" x2="317" y2="146"/>
<rect class="netem" x="318" y="133" width="66" height="26" rx="5"/>
<text class="small" x="351" y="150" text-anchor="middle">netem</text>
<line class="data" x1="384" y1="146" x2="470" y2="146" marker-end="url(#tl-data-head)"/>
<text class="small" x="209" y="139" text-anchor="middle">data</text>
<text class="small" x="431" y="139" text-anchor="middle">data</text>
<line class="ack" x1="472" y1="204" x2="323" y2="204"/>
<rect class="netem" x="256" y="191" width="66" height="26" rx="5"/>
<text class="small" x="289" y="208" text-anchor="middle">netem</text>
<line class="ack" x1="256" y1="204" x2="170" y2="204" marker-end="url(#tl-ack-head)"/>
<text class="small" x="209" y="197" text-anchor="middle">ACKs</text>
<text class="small" x="431" y="197" text-anchor="middle">ACKs</text>
<text class="small" x="320" y="284" text-anchor="middle">data direction (rb): delay 10ms · rate 100Mbit · limit 200 · loss p%</text>
<text class="small" x="320" y="304" text-anchor="middle">ACK direction (ra): delay 10ms</text>
<text class="muted small" x="320" y="330" text-anchor="middle">limit 200 = ~83 packets sitting out the delay + ~117 of actual queue</text>
</svg>
</figure>

A few details turned out to matter more than expected:

- **Offloads off.** With segmentation offloads on, the stack hands the
  virtual device 64KB super-packets, and netem drops them whole. "1% of
  packets" would really mean 1% of 45-packet bursts.
- **Impairment on a separate hop.** netem sits on the router, not on the
  sender's own interface, so the sending stack never sees a drop happen
  inside its own host.
- **The queue is smaller than it says.** netem's `limit` of 200 packets
  counts everything it holds, including the ~83 packets that are just
  sitting out the 10ms delay. That leaves about 117 packets of actual
  queue, 0.7 of the BDP. I only noticed this when the simulator further
  down refused to match the measured queueing delay with 200.

The numbers below are single 20s runs on Linux 7.2.6. The full code,
`bench.sh` and the namespace setup are in
[`tcp-loss`](https://github.com/darfire/bloggy-code/tree/main/tcp-loss).

## Throughput against loss

Bulk transfer, 20ms round trip, 100Mbit bottleneck, random loss on the
data direction only:

| loss  | reno, Mbit/s | cubic, Mbit/s | Mathis, Mbit/s |
|-------|-------------:|--------------:|---------------:|
| 0     |         93.4 |          95.2 |              - |
| 0.01% |         62.5 |          71.6 |           70.9 |
| 0.1%  |         24.2 |          21.1 |           22.4 |
| 1%    |          6.1 |           5.5 |            7.1 |

At no loss, both fill the link: 95.6Mbit/s is the most the payload can
get once headers are paid for. One packet in ten thousand already costs
a quarter to a third of the throughput. One in a thousand costs three
quarters. A separate run of reno at 5% loss got 2.6Mbit/s.

The losses here aren't congestion. The link has spare capacity the whole
time, and the drops are random. But a loss-based CC can't tell the
difference: every loss is read as "the queue overflowed", and the window
is cut.

Single 20s runs are noisy, more so at low loss rates. At 0.01%, a run
sees only ten or twenty random losses, and cubic got 71.6Mbit/s in this
run and 92.9Mbit/s in an earlier one. At higher loss rates, repeated
runs still differed by up to 20%: reno at 1% got 6.1Mbit/s here and 7.3
in another run. Treat the table as the shape of the curve, not as
numbers to three digits.

## The Mathis formula

The last column is a prediction, from a 1997 paper by Mathis, Semke,
Mahdavi and Ott, for Reno on a path that loses a fraction p of its
packets:

{{< katex >}}

$$
\text{throughput} \approx \frac{\text{MSS}}{\text{RTT}} \cdot \frac{C}{\sqrt{p}},
\qquad C = \sqrt{3/2} \approx 1.22
$$

The intuition is the sawtooth. Between two losses, the sender gets about
1/p packets through. Its window climbs by one packet per round trip and
halves at each loss, so a sawtooth that peaks at W packets carries on
the order of W² packets per cycle - the area under it. For that area to
be only 1/p, the window can't get much past 1/√p. One window per round
trip gives the formula.

<figure class="tl-mathis">
<style>
.tl-mathis svg { display: block; width: 100%; max-width: 680px; height: auto; margin: 0 auto; }
.tl-mathis text { fill: currentColor; font: 13px system-ui, sans-serif; }
.tl-mathis .title { font-weight: 600; font-size: 14px; }
.tl-mathis .muted { opacity: 0.7; }
.tl-mathis .small { font-size: 12px; }
.tl-mathis .axis, .tl-mathis .tick { stroke: rgb(var(--color-neutral-400)); stroke-width: 1.5; }
.tl-mathis .saw { fill: none; stroke: #eb6834; stroke-width: 2; stroke-linejoin: round; }
.tl-mathis .area { fill: rgba(235, 104, 52, 0.18); }
.tl-mathis .avg { stroke: rgb(var(--color-neutral-500)); stroke-width: 1.5; stroke-dasharray: 5 4; }
.tl-mathis .loss { font-size: 15px; font-weight: 600; }
.dark .tl-mathis .saw { stroke: #d95926; }
.dark .tl-mathis .area { fill: rgba(217, 89, 38, 0.25); }
.dark .tl-mathis .avg { stroke: rgb(var(--color-neutral-400)); }
</style>
<svg viewBox="0 0 640 306" role="img" aria-labelledby="tl-mathis-title">
<title id="tl-mathis-title">Two Reno sawtooths on the same axes. Left, loss rate p: the window climbs from W/2 to W over W/2 round trips, and one cycle carries about 1/p packets. Right, loss rate 4p: each cycle carries a quarter as many packets, so the sawtooth is half as tall and half as long, and the average window, and with it the throughput, is halved.</title>
<text class="title" x="181" y="36" text-anchor="middle">loss p</text>
<polygon class="area" points="56,240 56,160 181,80 181,240"/>
<text class="small" x="122" y="226" text-anchor="middle">≈ 1/p packets</text>
<line class="avg" x1="56" y1="120" x2="306" y2="120"/>
<path class="saw" d="M56,160 L181,80 L181,160 L306,80 L306,160"/>
<text class="loss" x="181" y="73" text-anchor="middle">×</text>
<text class="loss" x="306" y="73" text-anchor="middle">×</text>
<line class="axis" x1="56" y1="240" x2="312" y2="240"/>
<line class="axis" x1="56" y1="240" x2="56" y2="50"/>
<text class="muted small" x="50" y="84" text-anchor="end">W</text>
<text class="muted small" x="50" y="164" text-anchor="end">W/2</text>
<line class="tick" x1="56" y1="244" x2="56" y2="252"/>
<line class="tick" x1="181" y1="244" x2="181" y2="252"/>
<line class="tick" x1="56" y1="248" x2="181" y2="248"/>
<text class="muted small" x="118" y="266" text-anchor="middle">W/2 round trips</text>
<text class="muted small" x="312" y="266" text-anchor="end">time</text>
<text class="title" x="495" y="36" text-anchor="middle">loss 4p</text>
<polygon class="area" points="370,240 370,200 432,160 432,240"/>
<text class="small" x="405" y="226" text-anchor="middle">1/(4p)</text>
<line class="avg" x1="370" y1="180" x2="620" y2="180"/>
<path class="saw" d="M370,200 L432,160 L432,200 L495,160 L495,200 L558,160 L558,200 L620,160 L620,200"/>
<text class="loss" x="432" y="153" text-anchor="middle">×</text>
<text class="loss" x="495" y="153" text-anchor="middle">×</text>
<text class="loss" x="558" y="153" text-anchor="middle">×</text>
<text class="loss" x="620" y="153" text-anchor="middle">×</text>
<line class="axis" x1="370" y1="240" x2="626" y2="240"/>
<line class="axis" x1="370" y1="240" x2="370" y2="50"/>
<text class="muted small" x="364" y="164" text-anchor="end">W/2</text>
<text class="muted small" x="364" y="204" text-anchor="end">W/4</text>
<line class="tick" x1="370" y1="244" x2="370" y2="252"/>
<line class="tick" x1="432" y1="244" x2="432" y2="252"/>
<line class="tick" x1="370" y1="248" x2="432" y2="248"/>
<text class="muted small" x="401" y="266" text-anchor="middle">W/4</text>
<text class="muted small" x="626" y="266" text-anchor="end">time</text>
<line class="avg" x1="160" y1="290" x2="184" y2="290"/>
<text class="muted small" x="190" y="294">average window, ¾ of the peak</text>
<text class="loss" x="420" y="294" text-anchor="middle">×</text>
<text class="muted small" x="430" y="294">loss: cwnd halves</text>
</svg>
</figure>

## Where the queue goes

The benchmark also samples the kernel's smoothed RTT throughout each
run. Its average minus its minimum is the delay the queue at the
bottleneck added:

| loss  | reno, ms | cubic, ms | reno, retransmits | cubic, retransmits |
|-------|---------:|----------:|------------------:|-------------------:|
| 0     |      6.7 |       9.2 |               281 |                 22 |
| 0.01% |      1.5 |       1.6 |               229 |                 28 |
| 0.1%  |      1.4 |       0.8 |               276 |                 48 |
| 1%    |      1.3 |       1.4 |               123 |                117 |

At no loss, both keep a standing queue: they grow until it overflows,
which is the only signal they have. Reno averages less of it because
its sawtooth spends half its time well below the top; cubic flattens out
near the top and stays there. With random loss, the queue disappears.
cwnd never gets as far as the BDP, the link is partly idle, and the
remaining ~1ms is probably bursts of packets passing through, not a
standing queue.

The retransmit column has a surprise in it. At no loss at all, reno
retransmitted 281 packets, and at 0.01% loss, 229 - far more than the
ten or so random drops. Almost all of them come from the end of slow
start. Doubling the window every round trip overshoots the path's
capacity, and the sender doesn't hear about the first drop until a round
trip later. Until then, every returning ACK still releases two new
packets, and the full queue drops one of them. That's about one path's
worth of drops - the BDP plus the queue, 282 packets here - in one go.
Cubic's HyStart sees the queue forming and stops before that, which is
the whole difference between 281 and 22.

## A simulator

The measurements say what happens. To get a feel for why, it helps to
change the parameters faster than a benchmark can. Below is a small
model of a single flow, stepped one round trip at a time: cwnd packets
go out, whatever exceeds the BDP queues and adds delay, whatever exceeds
the queue is dropped, and on top of that each packet is lost at random
with the chosen probability. A round with any loss cuts the window
once; a round without grows it, by Reno's or cubic's rule. The defaults
are the test link above, and where a setting matches a measured run, the
Linux number is shown next to the model.

<div class="tcpsim" data-loss="0.1"></div>
<script src="/js/tcpsim.js" defer></script>

Some things to try: drag the loss down to 0 and watch the queue fill;
raise the round trip time at a fixed loss and watch throughput fall with
it, as Mathis says it should; give the link a 1Gbit/s bottleneck at
0.1% loss and see that it makes no difference at all.

The model leaves out everything that happens below the window: SACK,
RACK, timeouts, delayed ACKs and pacing. Even so, at most settings it
lands close to the measured throughput, queueing delay and retransmits,
including the slow-start overshoot. The model was also what exposed
netem's smaller-than-advertised queue.

## So, what

To a loss-based congestion control, every lost packet is a sign that the
path is full. On a link where loss means congestion, that's the right
reaction, and it's what has kept the internet from collapsing since
1988. On a link that drops packets for other reasons - radio, a bad
cable, an overloaded middlebox - the same reaction leaves most of the
capacity unused, and nothing at the application level shows why: no
errors, no failed requests, just a transfer that's ten times slower than
the link.

Two numbers to take away. The cost of random loss goes as its square
root, so even small loss rates are expensive. And it goes up with the
round trip time, so the same loss hurts far-away servers more.

There's a congestion control that doesn't treat loss as a congestion
signal at all. On the same link at 1% loss it gets 93Mbit/s. That's
BBR, and it's the subject of the next post.

## References

- V. Jacobson, [Congestion Avoidance and Control](https://ee.lbl.gov/papers/congavoid.pdf) (1988) - slow start, AIMD, and the reasoning behind them
- M. Mathis, J. Semke, J. Mahdavi, T. Ott, [The Macroscopic Behavior of the TCP Congestion Avoidance Algorithm](https://dl.acm.org/doi/10.1145/263932.264023) (1997) - the throughput formula
- [RFC 9438 - CUBIC for Fast and Long-Distance Networks](https://www.rfc-editor.org/rfc/rfc9438) - the curve, β = 0.7 and the Reno-friendly region
- S. Ha, I. Rhee, [Taming the elephants: New TCP slow start](https://doi.org/10.1016/j.comnet.2011.01.014) (2011) - HyStart
- [RFC 8985 - The RACK-TLP Loss Detection Algorithm for TCP](https://www.rfc-editor.org/rfc/rfc8985) - how Linux detects losses today
- [tc-netem(8)](https://man7.org/linux/man-pages/man8/tc-netem.8.html) - delay, rate and loss emulation
- [darfire/bloggy-code - tcp-loss](https://github.com/darfire/bloggy-code/tree/main/tcp-loss) - the test program, namespace setup, `bench.sh` and the simulator
