/* ============================================================
   COMPTES & SESSIONS — node:crypto uniquement, zéro dépendance
   ============================================================
   Design arrêté : PAS d'auto-inscription — l'admin crée les comptes
   (page admin). Les mots de passe ne sont JAMAIS stockés en clair :
   scrypt (node:crypto) avec sel aléatoire par compte. Les sessions
   vivent en mémoire (token → utilisateur), plusieurs simultanées
   autorisées (PC + mobile). Premier lancement sans compte admin :
   un admin est créé avec un mot de passe aléatoire affiché UNE
   SEULE FOIS dans la console du serveur. */

import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export type Level = 'admin' | 'super' | 'player';

export type Account = {
  username: string;
  hash: string;      // scrypt hex
  salt: string;      // hex
  level: Level;
  disabled: boolean;
  carId: number | null;   // voiture attribuée après configuration
  created: number;
};

export type Session = { token: string; user: string; since: number };

const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEYLEN = 64;

export function hashPassword(pass: string, saltHex?: string): { hash: string; salt: string } {
  const salt = saltHex ?? randomBytes(16).toString('hex');
  const hash = scryptSync(pass, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).toString('hex');
  return { hash, salt };
}

/* comparaison en temps constant — jamais de fuite par la durée */
export function verifyPassword(pass: string, acc: Account): boolean {
  const { hash } = hashPassword(pass, acc.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(acc.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function randomPassword(): string {
  /* lisible à la console, sans caractères ambigus */
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = randomBytes(12);
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/* ---- persistance : server/accounts.json ---- */
export class AccountStore {
  accounts: Map<string, Account> = new Map();
  sessions: Map<string, Session> = new Map();
  #file: string;

  constructor(file: string) {
    this.#file = file;
    if (existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as Account[];
        for (const a of data) this.accounts.set(a.username, a);
      } catch (e) {
        console.error('Comptes illisibles, fichier ignoré :', e);
      }
    }
  }

  save() {
    const data = [...this.accounts.values()];
    try {
      writeFileSync(this.#file, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('Sauvegarde des comptes impossible :', e);
    }
  }

  ensureAdmin(): string | null {
    /* premier lancement : un admin par défaut, mot de passe affiché
       UNE SEULE FOIS — modifiable depuis la page admin */
    if ([...this.accounts.values()].some((a) => a.level === 'admin' && !a.disabled)) return null;
    const pass = randomPassword();
    const { hash, salt } = hashPassword(pass);
    const acc: Account = {
      username: 'admin', hash, salt, level: 'admin',
      disabled: false, carId: null, created: Date.now(),
    };
    this.accounts.set('admin', acc);
    this.save();
    return pass;
  }

  login(user: string, pass: string): Session | null {
    const acc = this.accounts.get(user);
    if (!acc || acc.disabled) return null;
    if (!verifyPassword(pass, acc)) return null;
    const token = newToken();
    const s: Session = { token, user, since: Date.now() };
    this.sessions.set(token, s);
    /* n°29 : plafond de sessions par compte (PC + mobile + onglets) —
       les sessions n'expiraient jamais côté serveur */
    const mine = [...this.sessions.values()].filter((x) => x.user === user);
    if (mine.length > 5) this.sessions.delete(mine[0].token);
    return s;
  }

  logout(token: string) {
    this.sessions.delete(token);
  }

  byToken(token: string | undefined): Account | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    const acc = this.accounts.get(s.user) ?? null;
    /* n°29 : le compte a pu être désactivé hors setDisabled (fichier
       édité, restore) — une session d'un désactivé n'est plus valide */
    return acc && !acc.disabled ? acc : null;
  }

  create(user: string, pass: string, level: Level): Account | { error: string } {
    if (this.accounts.has(user)) return { error: 'identifiant déjà pris' };
    if (user.length < 2 || user.length > 20 || !/^[a-zA-Z0-9._-]+$/.test(user)) {
      return { error: 'identifiant invalide (2-20 caractères alphanumériques)' };
    }
    if (pass.length < 6) return { error: 'mot de passe trop court (6 caractères min.)' };
    const { hash, salt } = hashPassword(pass);
    const acc: Account = {
      username: user, hash, salt, level,
      disabled: false, carId: null, created: Date.now(),
    };
    this.accounts.set(user, acc);
    this.save();
    return acc;
  }

  resetPassword(user: string, newPass: string): boolean {
    const acc = this.accounts.get(user);
    if (!acc) return false;
    if (newPass.length < 6) return false;
    const { hash, salt } = hashPassword(newPass);
    acc.hash = hash;
    acc.salt = salt;
    this.save();
    return true;
  }

  setLevel(user: string, level: Level): boolean {
    const acc = this.accounts.get(user);
    if (!acc) return false;
    acc.level = level;
    this.save();
    return true;
  }

  setDisabled(user: string, disabled: boolean): boolean {
    const acc = this.accounts.get(user);
    if (!acc) return false;
    acc.disabled = disabled;
    if (disabled) {
      for (const [t, s] of this.sessions) if (s.user === user) this.sessions.delete(t);
    }
    this.save();
    return true;
  }

  /* RÉCUPÉRATION d'urgence : régénère le mot de passe du compte
     « admin » (le recrée s'il a disparu) et le retourne en clair
     pour affichage unique — appelé par le flag serveur
     --reset-admin-pass. Le stockage reste haché ; les sessions
     sont en mémoire et tombent de toute façon au redémarrage. */
  resetAdminPassword(): string {
    const pass = randomPassword();
    const { hash, salt } = hashPassword(pass);
    const existing = this.accounts.get('admin');
    if (existing) {
      existing.hash = hash;
      existing.salt = salt;
      existing.disabled = false;
    } else {
      this.accounts.set('admin', {
        username: 'admin', hash, salt, level: 'admin',
        disabled: false, carId: null, created: Date.now(),
      });
    }
    this.save();
    return pass;
  }
}
