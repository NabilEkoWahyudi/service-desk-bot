'use strict';

class SlidingWindowRateLimiter {
  constructor(limit, windowMs, records = new Map(), onChange = () => {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.records = records;
    this.onChange = onChange;
  }

  reserve(keys, now = Date.now()) {
    const uniqueKeys = [...new Set(keys.filter(Boolean))];
    const activeRecords = new Map();
    let changed = false;

    for (const key of uniqueKeys) {
      const current = this.records.get(key) || [];
      const active = current.filter(timestamp => now - timestamp < this.windowMs);
      if (active.length !== current.length) changed = true;
      if (active.length) this.records.set(key, active);
      else this.records.delete(key);
      activeRecords.set(key, active);
    }

    const blocked = [...activeRecords.values()].filter(events => events.length >= this.limit);
    if (blocked.length) {
      if (changed) this.onChange();
      const resetInMs = Math.max(...blocked.map(events => this.windowMs - (now - events[0])));
      return { allowed: false, resetInMs };
    }

    for (const [key, events] of activeRecords) {
      events.push(now);
      this.records.set(key, events);
    }
    this.onChange();
    return { allowed: true, reservation: { keys: uniqueKeys, timestamp: now } };
  }

  rollback(reservation) {
    if (!reservation) return;
    for (const key of reservation.keys) {
      const events = this.records.get(key) || [];
      const index = events.lastIndexOf(reservation.timestamp);
      if (index !== -1) events.splice(index, 1);
      if (events.length) this.records.set(key, events);
      else this.records.delete(key);
    }
    this.onChange();
  }
}

class DuplicateTicketGuard {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.recent = new Map();
    this.inFlight = new Map();
  }

  reserve(fingerprint, now = Date.now()) {
    for (const [key, timestamp] of this.recent) {
      if (now - timestamp >= this.windowMs) this.recent.delete(key);
    }

    if (this.recent.has(fingerprint) || this.inFlight.has(fingerprint)) return null;
    const token = Symbol(fingerprint);
    this.inFlight.set(fingerprint, token);
    return { fingerprint, token };
  }

  commit(reservation, now = Date.now()) {
    if (!reservation || this.inFlight.get(reservation.fingerprint) !== reservation.token) return;
    this.inFlight.delete(reservation.fingerprint);
    this.recent.set(reservation.fingerprint, now);
  }

  release(reservation) {
    if (!reservation || this.inFlight.get(reservation.fingerprint) !== reservation.token) return;
    this.inFlight.delete(reservation.fingerprint);
  }
}

module.exports = { SlidingWindowRateLimiter, DuplicateTicketGuard };