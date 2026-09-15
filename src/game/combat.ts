/**
 * Combat math — TS port of combat.cpp.
 * Must match C++ exactly for determinism.
 */

import { MT19937 } from "./rng.js";

export interface PlayerStats {
  level: number;
  strength: number;
  dexterity: number;
  constitution: number;
  intelligence: number;
  equipAttack: number;
  equipDefense: number;
}

export interface AttackResult {
  hit: boolean;
  critical: boolean;
  damage: number;
}

export function playerAttackPower(stats: PlayerStats): number {
  return stats.strength + Math.floor(stats.level / 2) + stats.equipAttack;
}

export function playerDefense(stats: PlayerStats): number {
  return Math.floor(stats.constitution / 2) + Math.floor(stats.level / 3)
       + stats.equipDefense;
}

export function playerAttackMonster(stats: PlayerStats, monsterDefense: number,
                                     rng: MT19937): AttackResult {
  const baseDmg = playerAttackPower(stats);

  // Miss chance.
  const missChance = Math.min(0.25,
    monsterDefense / (baseDmg + monsterDefense) * 0.4);

  if (rng.nextRange(1, 100) <= Math.floor(missChance * 100)) {
    return { hit: false, critical: false, damage: 0 };
  }

  // Damage variance 80-120%.
  let dmg = baseDmg * rng.nextRange(80, 120) / 100.0;

  // Critical hit.
  const critChance = 5 + Math.floor(stats.dexterity / 5);
  let critical = false;
  if (rng.nextRange(1, 100) <= critChance) {
    critical = true;
    dmg *= 1.5;
  }

  const finalDmg = Math.max(1, Math.floor(dmg) - monsterDefense);
  return { hit: true, critical, damage: finalDmg };
}

/**
 * Resolves one hostile participant attacking another in a duel
 * (SPEC_multiplayer_pvp.md section 4).  TS port of PlayerAttackPlayer in
 * combat.cpp: the existing formulas composed in a FIXED draw order, so
 * parity is mechanical.
 *
 *   1. miss   (attacker's roll, as against a monster), returning BEFORE
 *      the dodge roll is drawn -- the draw COUNT is consensus, not just
 *      the outcome, so the early return must stay exactly here;
 *   2. dodge  (defender's roll, as against a monster's attack);
 *   3. variance 80-120% of the attacker's power;
 *   4. critical, 5 + dex/5 percent, multiplying by 1.5;
 *   5. damage max(1, floor(dmg) - defender's defense).
 *
 * There is no retaliation roll: the defender answers on its own action.
 */
export function playerAttackPlayer(attacker: PlayerStats,
                                    defender: PlayerStats,
                                    rng: MT19937): AttackResult {
  const baseDmg = playerAttackPower(attacker);
  const defenderDef = playerDefense(defender);

  // 1. Miss chance, exactly as against a monster: the defender's defense
  //    stands in for the monster's.
  const missChance = Math.min(0.25,
    defenderDef / (baseDmg + defenderDef) * 0.4);
  if (rng.nextRange(1, 100) <= Math.floor(missChance * 100)) {
    return { hit: false, critical: false, damage: 0 };
  }

  // 2. Dodge chance, exactly as against a monster's attack.
  const dodgeChance = Math.min(50, 5 + Math.floor(defender.dexterity * 0.5));
  if (rng.nextRange(1, 100) <= dodgeChance) {
    return { hit: false, critical: false, damage: 0 };
  }

  // 3. Damage variance 80-120%.
  let dmg = baseDmg * rng.nextRange(80, 120) / 100.0;

  // 4. Critical hit: 5 + dex/5 percent.
  const critChance = 5 + Math.floor(attacker.dexterity / 5);
  let critical = false;
  if (rng.nextRange(1, 100) <= critChance) {
    critical = true;
    dmg *= 1.5;
  }

  // 5. Subtract the defender's defense.
  return { hit: true, critical, damage: Math.max(1, Math.floor(dmg) - defenderDef) };
}

export function monsterAttackPlayer(monsterAttack: number,
                                     monsterCritChance: number,
                                     stats: PlayerStats,
                                     rng: MT19937): AttackResult {
  const pDef = playerDefense(stats);

  // Dodge chance.
  const dodgeChance = Math.min(50,
    5 + Math.floor(stats.dexterity * 0.5));

  if (rng.nextRange(1, 100) <= dodgeChance) {
    return { hit: false, critical: false, damage: 0 };
  }

  // Damage variance 90-110%.
  let dmg = monsterAttack * rng.nextRange(90, 110) / 100.0;

  // Monster crit.
  let critical = false;
  if (rng.nextRange(1, 100) <= monsterCritChance) {
    critical = true;
    dmg *= 1.5;
  }

  const finalDmg = Math.max(1, Math.floor(dmg) - pDef);
  return { hit: true, critical, damage: finalDmg };
}
