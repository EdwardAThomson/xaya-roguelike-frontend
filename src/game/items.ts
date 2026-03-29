/**
 * Item database — TS port of items.cpp.
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
  healAmount: number;
  value: number;
  consumable: boolean;
}

const ITEMS: ItemDef[] = [
  /* Weapons */
  { id: "dagger",       name: "Dagger",       type: "weapon", slot: "weapon", icon: "🗡️", color: "#e74c3c", attackPower: 3,  defense: 0, healAmount: 0,  value: 10,  consumable: false },
  { id: "short_sword",  name: "Short Sword",  type: "weapon", slot: "weapon", icon: "🗡️", color: "#e74c3c", attackPower: 5,  defense: 0, healAmount: 0,  value: 25,  consumable: false },
  { id: "iron_sword",   name: "Iron Sword",   type: "weapon", slot: "weapon", icon: "⚔️", color: "#e74c3c", attackPower: 6,  defense: 0, healAmount: 0,  value: 35,  consumable: false },
  { id: "long_sword",   name: "Long Sword",   type: "weapon", slot: "weapon", icon: "⚔️", color: "#e74c3c", attackPower: 8,  defense: 0, healAmount: 0,  value: 50,  consumable: false },
  { id: "battle_axe",   name: "Battle Axe",   type: "weapon", slot: "weapon", icon: "🪓", color: "#e74c3c", attackPower: 10, defense: 0, healAmount: 0,  value: 65,  consumable: false },
  { id: "mace",         name: "Iron Mace",    type: "weapon", slot: "weapon", icon: "🔨", color: "#e74c3c", attackPower: 7,  defense: 0, healAmount: 0,  value: 42,  consumable: false },
  { id: "staff",        name: "Wooden Staff",  type: "weapon", slot: "weapon", icon: "🪄", color: "#9b59b6", attackPower: 4,  defense: 0, healAmount: 0,  value: 40,  consumable: false },

  /* Head armor */
  { id: "leather_cap",  name: "Leather Cap",  type: "armor", slot: "head", icon: "🧢", color: "#3498db", attackPower: 0, defense: 1, healAmount: 0, value: 15, consumable: false },
  { id: "iron_helmet",  name: "Iron Helmet",  type: "armor", slot: "head", icon: "⛑️", color: "#3498db", attackPower: 0, defense: 3, healAmount: 0, value: 40, consumable: false },

  /* Body armor */
  { id: "leather_armor", name: "Leather Armor",  type: "armor", slot: "body", icon: "🛡️", color: "#3498db", attackPower: 0, defense: 2, healAmount: 0, value: 25,  consumable: false },
  { id: "chainmail",     name: "Chainmail",      type: "armor", slot: "body", icon: "🛡️", color: "#3498db", attackPower: 0, defense: 4, healAmount: 0, value: 60,  consumable: false },
  { id: "plate_armor",   name: "Plate Armor",    type: "armor", slot: "body", icon: "🛡️", color: "#3498db", attackPower: 0, defense: 7, healAmount: 0, value: 100, consumable: false },

  /* Feet */
  { id: "leather_boots", name: "Leather Boots", type: "armor", slot: "feet", icon: "👢", color: "#3498db", attackPower: 0, defense: 1, healAmount: 0, value: 20, consumable: false },
  { id: "iron_boots",    name: "Iron Boots",    type: "armor", slot: "feet", icon: "👢", color: "#3498db", attackPower: 0, defense: 2, healAmount: 0, value: 35, consumable: false },

  /* Shields */
  { id: "wooden_shield", name: "Wooden Shield", type: "armor", slot: "offhand", icon: "🛡️", color: "#3498db", attackPower: 0, defense: 2, healAmount: 0, value: 25,  consumable: false },
  { id: "iron_shield",   name: "Iron Shield",   type: "armor", slot: "offhand", icon: "🛡️", color: "#3498db", attackPower: 0, defense: 4, healAmount: 0, value: 60,  consumable: false },
  { id: "tower_shield",  name: "Tower Shield",  type: "armor", slot: "offhand", icon: "🛡️", color: "#3498db", attackPower: 0, defense: 7, healAmount: 0, value: 120, consumable: false },

  /* Accessories */
  { id: "silver_ring",        name: "Silver Ring",        type: "accessory", slot: "ring",   icon: "💍", color: "#f1c40f", attackPower: 0, defense: 2, healAmount: 0, value: 45, consumable: false },
  { id: "ring_of_protection", name: "Ring of Protection", type: "accessory", slot: "ring",   icon: "💍", color: "#f1c40f", attackPower: 0, defense: 2, healAmount: 0, value: 80, consumable: false },
  { id: "bone_necklace",      name: "Bone Necklace",      type: "accessory", slot: "amulet", icon: "📿", color: "#f1c40f", attackPower: 2, defense: 0, healAmount: 0, value: 35, consumable: false },
  { id: "amulet_of_health",   name: "Amulet of Health",   type: "accessory", slot: "amulet", icon: "📿", color: "#f1c40f", attackPower: 0, defense: 0, healAmount: 0, value: 75, consumable: false },

  /* Potions */
  { id: "health_potion",         name: "Health Potion",         type: "potion", slot: "", icon: "⚗️", color: "#2ecc71", attackPower: 0, defense: 0, healAmount: 20, value: 15, consumable: true },
  { id: "greater_health_potion", name: "Greater Health Potion", type: "potion", slot: "", icon: "⚗️", color: "#27ae60", attackPower: 0, defense: 0, healAmount: 50, value: 40, consumable: true },
  { id: "mana_potion",           name: "Mana Potion",           type: "potion", slot: "", icon: "⚗️", color: "#3498db", attackPower: 0, defense: 0, healAmount: 0,  value: 15, consumable: true },

  /* Misc */
  { id: "gold_coins", name: "Gold Coins", type: "misc", slot: "", icon: "💰", color: "#f1c40f", attackPower: 0, defense: 0, healAmount: 0, value: 1, consumable: false },
];

const itemMap = new Map<string, ItemDef>();
for (const item of ITEMS) {
  itemMap.set(item.id, item);
}

export function lookupItem(id: string): ItemDef | undefined {
  return itemMap.get(id);
}

export function getSpawnableItems(depth: number): ItemDef[] {
  return ITEMS.filter(item => {
    if (item.id === "gold_coins" || item.id === "mana_potion") return false;
    if (item.type === "potion") {
      if (item.id === "greater_health_potion" && depth < 3) return false;
      return true;
    }
    if (item.type === "weapon" || item.type === "armor" || item.type === "accessory") {
      return item.value <= depth * 20 + 30;
    }
    return false;
  });
}
