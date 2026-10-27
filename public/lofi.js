// Route Radio — an original, procedurally generated lofi engine (Web Audio, no audio files).
// Jazzy 7th chords on a soft electric piano, a gentle Game Boy–style square lead,
// boom-bap drums with swing, vinyl crackle, and optional rain / waves ambience.

const STATIONS = [
  { name: "Rainy Route",    bpm: 72, ambience: "rain",  lead: 0.8,
    chords: [[55,58,62,65],[48,52,55,58],[53,57,60,64],[50,53,57,60]] },   // Gm7 C7 Fmaj7 Dm7
  { name: "Center Nights",  bpm: 78, ambience: "none",  lead: 1,
    chords: [[48,52,55,59],[45,48,52,55],[50,53,57,60],[43,47,50,53]] },   // Cmaj7 Am7 Dm7 G7
  { name: "Seaside Town",   bpm: 84, ambience: "waves", lead: 0.9,
    chords: [[51,55,58,62],[48,51,55,58],[44,48,51,55],[46,50,53,56]] },   // Ebmaj7 Cm7 Abmaj7 Bb7
  { name: "Moonlit Cave",   bpm: 68, ambience: "rain",  lead: 0.6,
    chords: [[45,48,52,55],[41,45,48,52],[50,53,57,60],[40,44,47,50]] },   // Am7 Fmaj7 Dm7 E7
];

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// small seeded RNG so each station has a stable "song" feel
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

export class LofiRadio {
  constructor() {
    this.ctx = null; this.playing = false; this.stationIndex = 0; this.volume = 0.6;
    this.onchange = () => {};
  }
  get station() { return STATIONS[this.stationIndex]; }
  get stations() { return STATIONS; }

  _init() {
    if (this.ctx) return;
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = ctx.createGain(); this.master.gain.value = 0;
    const tone = ctx.createBiquadFilter(); tone.type = "lowpass"; tone.frequency.value = 2600; tone.Q.value = 0.4;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 3;
    this.master.connect(tone).connect(comp).connect(ctx.destination);
    this.bus = ctx.createGain(); this.bus.connect(this.master);

    // tape wobble: slow LFO on a short delay = subtle pitch flutter
    const wob = ctx.createDelay(); wob.delayTime.value = 0.006;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.45;
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 0.0018;
    lfo.connect(lfoAmt).connect(wob.delayTime); lfo.start();
    this.music = ctx.createGain(); this.music.connect(wob).connect(this.bus);

    // noise buffer shared by drums / crackle / ambience
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    this._crackle();
    this.amb = ctx.createGain(); this.amb.connect(this.bus);
  }

  _crackle() {
    const ctx = this.ctx, len = ctx.sampleRate * 3, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() < 0.0009 ? (Math.random() * 2 - 1) * 0.9 : 0) + (Math.random() * 2 - 1) * 0.012;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 3200; bp.Q.value = 0.6;
    const g = ctx.createGain(); g.gain.value = 0.22;
    src.connect(bp).connect(g).connect(this.bus); src.start();
  }

  _ambience(kind) {
    if (this.ambSrc) { try { this.ambSrc.stop(); } catch {} this.ambSrc = null; }
    if (kind === "none") return;
    const ctx = this.ctx, src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    if (kind === "rain") { f.type = "highpass"; f.frequency.value = 1400; g.gain.value = 0.05; src.connect(f).connect(g); }
    else { // waves: low noise swelling with a slow LFO
      f.type = "lowpass"; f.frequency.value = 600; g.gain.value = 0.04;
      const lfo = ctx.createOscillator(), amt = ctx.createGain(); lfo.frequency.value = 0.09; amt.gain.value = 0.035;
      lfo.connect(amt).connect(g.gain); lfo.start(); src.connect(f).connect(g);
    }
    g.connect(this.amb); src.start(); this.ambSrc = src;
  }

  // ---------- instruments ----------
  _ep(midi, t, dur, vel) { // soft electric piano
    const ctx = this.ctx, g = ctx.createGain(), f = ctx.createBiquadFilter();
    f.type = "lowpass"; f.frequency.setValueAtTime(1800, t); f.frequency.exponentialRampToValueAtTime(700, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    for (const [type, det, lvl] of [["sine", 0, 1], ["triangle", 7, 0.35]]) {
      const o = ctx.createOscillator(), og = ctx.createGain(); o.type = type; o.frequency.value = mtof(midi); o.detune.value = det; og.gain.value = lvl;
      o.connect(og).connect(f); o.start(t); o.stop(t + dur + 0.05);
    }
    f.connect(g).connect(this.music);
  }
  _bass(midi, t, dur) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    o.type = "triangle"; o.frequency.value = mtof(midi); f.type = "lowpass"; f.frequency.value = 320;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.32, t + 0.03); g.gain.setTargetAtTime(0, t + dur * 0.7, 0.08);
    o.connect(f).connect(g).connect(this.music); o.start(t); o.stop(t + dur + 0.4);
  }
  _lead(midi, t, dur) { // Game Boy–ish pulse, softened
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    o.type = "square"; o.frequency.value = mtof(midi); f.type = "lowpass"; f.frequency.value = 1500;
    const vib = ctx.createOscillator(), va = ctx.createGain(); vib.frequency.value = 5; va.gain.value = 6; vib.connect(va).connect(o.detune);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.045 * this.station.lead, t + 0.015); g.gain.setTargetAtTime(0, t + dur * 0.8, 0.06);
    o.connect(f).connect(g).connect(this.music); o.start(t); vib.start(t); o.stop(t + dur + 0.3); vib.stop(t + dur + 0.3);
  }
  _kick(t) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(0.55, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    o.connect(g).connect(this.bus); o.start(t); o.stop(t + 0.35);
  }
  _snare(t) {
    const ctx = this.ctx, n = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    n.buffer = this.noise; f.type = "bandpass"; f.frequency.value = 1700; f.Q.value = 0.8;
    g.gain.setValueAtTime(0.16, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    n.connect(f).connect(g).connect(this.bus); n.start(t, Math.random()); n.stop(t + 0.22);
  }
  _hat(t, v) {
    const ctx = this.ctx, n = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    n.buffer = this.noise; f.type = "highpass"; f.frequency.value = 7500;
    g.gain.setValueAtTime(0.05 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    n.connect(f).connect(g).connect(this.bus); n.start(t, Math.random()); n.stop(t + 0.06);
  }

  // ---------- sequencer ----------
  _makeMotif() {
    const r = rng(1000 + this.stationIndex * 77 + this.loopCount);
    // a 2-bar motif of chord tones / pentatonic neighbours, 8th-note grid, plenty of rests
    const motif = [];
    for (let s = 0; s < 16; s++) motif.push(r() < 0.34 ? Math.floor(r() * 5) : null);
    return motif;
  }
  _schedule() {
    const st = this.station, spb = 60 / st.bpm, step = spb / 4; // 16th notes
    while (this.nextTime < this.ctx.currentTime + 0.15) {
      const i = this.step, t = this.nextTime + (i % 2 ? step * 0.16 : 0); // swing
      const bar = Math.floor(i / 16) % st.chords.length, chord = st.chords[bar], s16 = i % 16;
      if (s16 === 0) {
        chord.forEach((m, k) => this._ep(m + 12, t + k * 0.012, spb * 3.6, 0.07));
        this._bass(chord[0] - 12, t, spb * 1.6);
        if (i % (16 * st.chords.length) === 0) { this.loopCount++; this.motif = this._makeMotif(); }
      }
      if (s16 === 10) this._bass(chord[0] - 12, t, spb * 0.9);
      if (s16 === 0 || s16 === 7 || s16 === 10) this._kick(t);
      if (s16 === 4 || s16 === 12) this._snare(t);
      if (s16 % 2 === 0) this._hat(t, s16 % 4 ? 0.6 : 1);
      if (s16 % 2 === 0 && this.loopCount > 0) { // lead enters after the first loop
        const n = this.motif[(Math.floor(i / 2)) % 16];
        if (n !== null) { const tones = [chord[1], chord[2], chord[3], chord[0] + 12, chord[2] + 12]; this._lead(tones[n] + 12, t, step * 2.6); }
      }
      this.nextTime += step; this.step++;
    }
  }

  async play() {
    this._init();
    await this.ctx.resume();
    if (this.playing) return;
    this.playing = true; this.step = 0; this.loopCount = 0; this.motif = this._makeMotif();
    this.nextTime = this.ctx.currentTime + 0.1;
    this._ambience(this.station.ambience);
    this.timer = setInterval(() => this._schedule(), 25);
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.4);
    this.onchange();
  }
  pause() {
    if (!this.playing) return;
    this.playing = false; clearInterval(this.timer);
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
    setTimeout(() => { if (!this.playing) this._ambience("none"); }, 600);
    this.onchange();
  }
  toggle() { return this.playing ? this.pause() : this.play(); }
  next() {
    this.stationIndex = (this.stationIndex + 1) % STATIONS.length;
    if (this.playing) { this.step = 0; this.loopCount = 0; this.motif = this._makeMotif(); this.nextTime = this.ctx.currentTime + 0.15; this._ambience(this.station.ambience); }
    this.onchange();
  }
  // dip the music under a Pokémon cry, then bring it back
  duck(seconds = 1.2) {
    if (!this.playing) return;
    const t = this.ctx.currentTime, g = this.master.gain;
    g.cancelScheduledValues(t); g.setTargetAtTime(this.volume * 0.25, t, 0.05); g.setTargetAtTime(this.volume, t + seconds, 0.3);
  }
  setVolume(v) { this.volume = v; if (this.playing) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1); }
}
