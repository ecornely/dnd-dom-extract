/**
 * Schéma de sortie : personnage D&D 5e extrait d'une page D&D Beyond.
 * Tout ce qui n'est pas trouvé dans la source est `undefined` (omis du JSON)
 * plutôt que falsifié à 0.
 */

export const ABILITY_KEYS = ["STR", "DEX", "CON", "INT", "WIS", "CHA"] as const;
export type AbilityKey = (typeof ABILITY_KEYS)[number];

export const ABILITY_LABELS: Record<AbilityKey, string> = {
  STR: "Strength",
  DEX: "Dexterity",
  CON: "Constitution",
  INT: "Intelligence",
  WIS: "Wisdom",
  CHA: "Charisma",
};

export type ProficiencyType = "none" | "half" | "proficient" | "expertise";

export interface Ability {
  score: number;
  modifier: number;
}

export interface SavingThrow {
  value: number;
  proficient: boolean;
}

export interface Skill {
  name: string;
  /** Caractéristique dont dépend la compétence ("WIS", ...) */
  ability: AbilityKey | null;
  /** Valeur du jet de compétence */
  value: number | null;
  proficiency: ProficiencyType;
}

export interface CharacterClass {
  name: string;
  level: number | null;
  subclass: string | null;
}

export interface Defense {
  type: string;
  value: string;
}

/** Lancement de sorts d'une classe : mod (= mod. carac), bonus d'attaque
 *  de sort (= mod + PB) et DD de sauvegarde de sort (= 8 + mod + PB). */
export interface Spellcasting {
  className: string | null;
  ability: AbilityKey | null;
  modifier: number;
  attack: number;
  saveDc: number;
}

export interface Proficiencies {
  armor: string[];
  weapons: string[];
  tools: string[];
  languages: string[];
}

/** Une attaque d'arme du personnage (troisième page du thème, table Attaques). */
export interface Attack {
  name: string;
  /** Bonus d'attaque formaté ("+4"), calculé ou null si incalculable */
  bonus: string | null;
  /** Dégâts + type ("1d8+2 Piercing") */
  damage: string | null;
  /** Portée et propriétés ("5 ft., Finesse, Vex") */
  properties: string | null;
}

export interface Feature {
  name: string;
  section: string | null;
  description: string | null;
}

export interface EquipmentItem {
  name: string;
  quantity: number | null;
  /** Poids unitaire en livres (unité native DDB) */
  weight: number | null;
}

export interface Spell {
  name: string;
  /** Niveau de sort, 0 = tour de magie */
  level: number | null;
  school: string | null;
  castingTime: string | null;
  range: string | null;
  /** Durée formatée (ex. « 1 Minute », « Conc. 1 Minute », « Instantané ») */
  duration: string | null;
  /** Le sort inflige des dégâts (tag DDB « Damage ») */
  damaging: boolean;
  prepared: boolean | null;
}

export interface HitPoints {
  current: number | null;
  max: number | null;
  temp: number | null;
}

/**
 * Capacités qui consomment une « action » au sens large (tab Actions de
 * D&D Beyond). Noms seuls, groupés par le filtre du tab : coût d'activation
 * API (activation.activationType) — 1 = Action, 2 = Action bonus,
 * 3 = Réaction, le reste (0, 4-8, absent) = autre/special.
 */
export interface CharacterActions {
  action: string[];
  bonusAction: string[];
  reaction: string[];
  other: string[];
}

export interface Character {
  meta: {
    source: "embedded-json" | "dom" | "api";
    /** URL ou chemin du fichier analysé */
    sourceRef: string;
    extractedAt: string;
    characterId: string | null;
    /** Unités des valeurs numériques du JSON : la phase de traduction
     *  convertit les valeurs et réécrit ces unités (ft → m, lb → kg). */
    units: { distance: string; weight: string };
  };
  name: string | null;
  level: number | null;
  xp: number | null;
  race: string | null;
  /** Taille de créature (Small, Medium...) — null si absente de la source */
  size: string | null;
  background: string | null;
  alignment: string | null;
  classes: CharacterClass[];
  /** Une entrée par classe incantatrice — calculé depuis le JSON, pas le DOM. */
  spellcasting: Spellcasting[];
  abilities: Record<AbilityKey, Ability>;
  savingThrows: Record<AbilityKey, SavingThrow>;
  skills: Skill[];
  proficiencyBonus: number | null;
  armorClass: number | null;
  initiative: number | null;
  speed: string | null;
  passivePerception: number | null;
  /** Port de charge (FOR × 15, en unité de poids du JSON) */
  carryingCapacity: number | null;
  /** Pousser, traîner ou soulever (FOR × 30) */
  pushDragLift: number | null;
  hp: HitPoints;
  hitDice: string | null;
  deathSaves: { successes: number | null; failures: number | null } | null;
  coins: {
    cp: number | null;
    sp: number | null;
    ep: number | null;
    gp: number | null;
    pp: number | null;
  } | null;
  attacks: Attack[];
  actions: CharacterActions;
  defenses: {
    resistances: Defense[];
    immunities: Defense[];
    vulnerabilities: Defense[];
  };
  proficiencies: Proficiencies;
  features: Feature[];
  equipment: EquipmentItem[];
  spells: Spell[];
  /** Emplacements de sorts par niveau (index 0 = niveau 1), calculés depuis
   *  les tables ; vide si le personnage n'a aucun slot (index manquants = 0). */
  spellSlots: number[];
  personality: {
    traits: string[];
    ideals: string[];
    bonds: string[];
    flaws: string[];
    /** Tenue, voix, attitude (data.traits.appearance — distinct de la
     *  Description physique au-dessus) */
    appearance: string[];
  } | null;
  appearance: {
    age: string | null;
    eyes: string | null;
    height: string | null;
    hair: string | null;
    skin: string | null;
    weight: string | null;
  } | null;
  backstory: string | null;
  allies: string | null;
}
