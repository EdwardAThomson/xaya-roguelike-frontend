/**
 * Item database — TS port of items.cpp.
 *
 * Stat-bonus fields (strength/dexterity/constitution/intelligence/maxHealth)
 * are informational for the UI — the authoritative effective stats come
 * from the GSP's getplayerinfo.effective_stats.  But we keep them in sync
 * with backend items.cpp so the inventory view can explain why an item
 * matters.
 */

export interface ItemDef {
  id: string;
  name: string;
  type: string;
  slot: string;
  icon: string;
  color: string;
  attackPower: number;
  defense: number;
  strength: number;
  dexterity: number;
  constitution: number;
  intelligence: number;
  maxHealth: number;
  healAmount: number;
  value: number;
  consumable: boolean;
  stackable: boolean;
}

/* Helper so item rows stay readable.  Only the id, name, type, slot,
   icon, color and bonuses that differ from zero need to be filled in.  */
function item(partial: Partial<ItemDef> & Pick<ItemDef, "id" | "name" | "type" | "slot" | "icon" | "color" | "value">): ItemDef {
  return {
    attackPower: 0,
    defense: 0,
    strength: 0,
    dexterity: 0,
    constitution: 0,
    intelligence: 0,
    maxHealth: 0,
    healAmount: 0,
    consumable: false,
    stackable: false,
    ...partial,
  };
}

const ITEMS: ItemDef[] = [
  /* Weapons */
  item({ id: "dagger",      name: "Dagger",        type: "weapon", slot: "weapon", icon: "🗡️", color: "#e74c3c", attackPower: 3,  dexterity: 1,                value: 10  }),
  item({ id: "short_sword", name: "Short Sword",   type: "weapon", slot: "weapon", icon: "🗡️", color: "#e74c3c", attackPower: 5,                              value: 25  }),
  item({ id: "iron_sword",  name: "Iron Sword",    type: "weapon", slot: "weapon", icon: "⚔️", color: "#e74c3c", attackPower: 6,  strength: 1,                 value: 35  }),
  item({ id: "long_sword",  name: "Long Sword",    type: "weapon", slot: "weapon", icon: "⚔️", color: "#e74c3c", attackPower: 8,  strength: 1,                 value: 50  }),
  item({ id: "scimitar",    name: "Scimitar",      type: "weapon", slot: "weapon", icon: "⚔️", color: "#e74c3c", attackPower: 7,  dexterity: 1,                value: 38  }),
  item({ id: "battle_axe",  name: "Battle Axe",    type: "weapon", slot: "weapon", icon: "🪓", color: "#e74c3c", attackPower: 10, strength: 2, dexterity: -1,  value: 65  }),
  item({ id: "mace",        name: "Iron Mace",     type: "weapon", slot: "weapon", icon: "🔨", color: "#e74c3c", attackPower: 7,  strength: 1, constitution: 1, value: 42 }),
  item({ id: "staff",       name: "Wooden Staff",  type: "weapon", slot: "weapon", icon: "🪄", color: "#9b59b6", attackPower: 4,  intelligence: 2,             value: 40  }),

  /* Head armor */
  item({ id: "leather_cap", name: "Leather Cap",   type: "armor",  slot: "head",   icon: "🧢", color: "#3498db", defense: 1,                                   value: 15  }),
  item({ id: "iron_helmet", name: "Iron Helmet",   type: "armor",  slot: "head",   icon: "⛑️", color: "#3498db", defense: 3,  constitution: 1,                 value: 40  }),

  /* Body armor */
  item({ id: "leather_armor",   name: "Leather Armor",   type: "armor", slot: "body", icon: "🛡️", color: "#3498db", defense: 2,  dexterity: 1,                       value: 25  }),
  item({ id: "studded_leather", name: "Studded Leather", type: "armor", slot: "body", icon: "🛡️", color: "#3498db", defense: 3,  dexterity: 1,                       value: 40  }),
  item({ id: "scale_mail",      name: "Scale Mail",      type: "armor", slot: "body", icon: "🛡️", color: "#3498db", defense: 5,  constitution: 1,                    value: 50  }),
  item({ id: "chainmail",       name: "Chainmail",       type: "armor", slot: "body", icon: "🛡️", color: "#3498db", defense: 4,  dexterity: -1, constitution: 1,     value: 60  }),
  item({ id: "plate_armor",     name: "Plate Armor",     type: "armor", slot: "body", icon: "🛡️", color: "#3498db", defense: 7,  strength: 1, dexterity: -2, constitution: 2, value: 100 }),

  /* Feet */
  item({ id: "leather_boots",    name: "Leather Boots",    type: "armor", slot: "feet", icon: "👢", color: "#3498db", defense: 1, dexterity: 1,                       value: 20  }),
  item({ id: "iron_boots",       name: "Iron Boots",       type: "armor", slot: "feet", icon: "👢", color: "#3498db", defense: 2, dexterity: -1, constitution: 1,     value: 35  }),
  item({ id: "reinforced_boots", name: "Reinforced Boots", type: "armor", slot: "feet", icon: "👢", color: "#3498db", defense: 1, dexterity: 1, constitution: 1,      value: 28  }),

  /* Shields */
  item({ id: "wooden_shield",     name: "Wooden Shield",     type: "armor", slot: "offhand", icon: "🛡️", color: "#3498db", defense: 2,                                  value: 25  }),
  item({ id: "reinforced_shield", name: "Reinforced Shield", type: "armor", slot: "offhand", icon: "🛡️", color: "#3498db", defense: 3, constitution: 1,                 value: 40  }),
  item({ id: "iron_shield",       name: "Iron Shield",       type: "armor", slot: "offhand", icon: "🛡️", color: "#3498db", defense: 4, constitution: 1,                 value: 60  }),
  item({ id: "tower_shield",      name: "Tower Shield",      type: "armor", slot: "offhand", icon: "🛡️", color: "#3498db", defense: 7, dexterity: -1, constitution: 2,  value: 120 }),

  /* Accessories */
  item({ id: "silver_ring",        name: "Silver Ring",        type: "accessory", slot: "ring",   icon: "💍", color: "#f1c40f", defense: 2, strength: 3, dexterity: 1, value: 45 }),
  item({ id: "ring_of_protection", name: "Ring of Protection", type: "accessory", slot: "ring",   icon: "💍", color: "#f1c40f", defense: 2,                             value: 80 }),
  item({ id: "ring_of_strength",   name: "Ring of Strength",   type: "accessory", slot: "ring",   icon: "💍", color: "#f1c40f", strength: 2,                            value: 80 }),
  item({ id: "bone_necklace",      name: "Bone Necklace",      type: "accessory", slot: "amulet", icon: "📿", color: "#f1c40f", attackPower: 2, strength: 1,            value: 35 }),
  item({ id: "amulet_of_health",   name: "Amulet of Health",   type: "accessory", slot: "amulet", icon: "📿", color: "#f1c40f", constitution: 1, maxHealth: 15,         value: 75 }),

  /* Potions */
  item({ id: "health_potion",         name: "Health Potion",         type: "potion", slot: "", icon: "⚗️", color: "#2ecc71", healAmount: 20, value: 15, consumable: true, stackable: true }),
  item({ id: "greater_health_potion", name: "Greater Health Potion", type: "potion", slot: "", icon: "⚗️", color: "#27ae60", healAmount: 50, value: 40, consumable: true, stackable: true }),
  item({ id: "mana_potion",           name: "Mana Potion",           type: "potion", slot: "", icon: "⚗️", color: "#3498db", healAmount: 0,  value: 15, consumable: true, stackable: true }),

  /* Misc */
  item({ id: "gold_coins", name: "Gold Coins", type: "misc", slot: "", icon: "💰", color: "#f1c40f", value: 1, stackable: true }),
];

const itemMap = new Map<string, ItemDef>();
for (const it of ITEMS) {
  itemMap.set(it.id, it);
}

export function lookupItem(id: string): ItemDef | undefined {
  return itemMap.get(id);
}

export function getSpawnableItems(depth: number): ItemDef[] {
  return ITEMS.filter(it => {
    if (it.id === "gold_coins" || it.id === "mana_potion") return false;
    if (it.type === "potion") {
      if (it.id === "greater_health_potion" && depth < 3) return false;
      return true;
    }
    if (it.type === "weapon" || it.type === "armor" || it.type === "accessory") {
      return it.value <= depth * 20 + 30;
    }
    return false;
  });
}
