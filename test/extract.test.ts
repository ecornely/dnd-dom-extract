import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractCharacter, extractCharacterFromSources, extractFromDom, findEmbeddedCharacters } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "mock-beyond-sheet.html");
const orosJsonPath = join(here, "..", "samples", "oros.json");
const estherJsonPath = join(here, "..", "samples", "esther.json");
const elowenJsonPath = join(here, "..", "samples", "elowen.json");
const orosSpellsPath = join(here, "..", "samples", "oros-spells-tab.html");
const fixtureHtml = readFileSync(fixturePath, "utf8");
const orosJson = readFileSync(orosJsonPath, "utf8");
const estherJson = readFileSync(estherJsonPath, "utf8");
const elowenJson = readFileSync(elowenJsonPath, "utf8");
const orosSpellsHtml = readFileSync(orosSpellsPath, "utf8");

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("dnd-dom-extract — tests");

// ---------- Extraction du JSON embarqué (pages complètes) ----------

test("findEmbeddedCharacters extrait le JSON malgré les accolades dans les chaînes", () => {
  const found = findEmbeddedCharacters(fixtureHtml);
  assert.equal(found.length, 1);
  assert.equal(found[0].characterId, "12345678");
  const name = (found[0].data as { name?: string }).name;
  assert.equal(name, "Damaia Dread");
});

test("extraction auto : JSON embarqué prioritaire", () => {
  const c = extractCharacter(fixtureHtml, fixturePath);
  assert.equal(c.meta.source, "embedded-json");
  assert.equal(c.name, "Damaia Dread");
  assert.equal(c.abilities.CHA.score, 16);
  assert.deepEqual(c.classes, [{ name: "Bard", level: 2, subclass: "College of Lore" }]);
});

// ---------- Ancres textuelles (DOM seul) ----------

test("ancres DOM (fixture) : identité, caractéristiques, compétences", () => {
  const c = extractFromDom(fixtureHtml, fixturePath, new Date().toISOString());
  assert.equal(c.meta.source, "dom");
  assert.equal(c.name, "Oros Telluros");
  assert.equal(c.race, "Earth Genasi");
  assert.equal(c.level, 2);
  assert.deepEqual(c.classes, [{ name: "Druid", level: 2, subclass: null }]);

  assert.deepEqual(c.abilities.STR, { score: 13, modifier: 1 });
  assert.equal(c.abilities.DEX.modifier, 1);
  assert.equal(c.abilities.DEX.score, 12);
  assert.equal(c.abilities.CHA.modifier, -1);
  assert.equal(c.abilities.CHA.score, 8);

  // Seules STR/DEX sont définies dans la fixture (aria Proficient / Not Proficient)
  assert.deepEqual(c.savingThrows.WIS.value, 0);
  assert.deepEqual(c.savingThrows.STR, { value: 1, proficient: true });
  assert.deepEqual(c.savingThrows.DEX, { value: 1, proficient: false });
  assert.equal(c.skills.length, 2);
  const animalHandling = c.skills.find((s) => s.name === "Animal Handling");
  assert.ok(animalHandling);
  assert.equal(animalHandling.ability, "WIS");
  assert.equal(animalHandling.value, 3);
  assert.equal(animalHandling.proficiency, "proficient");

  assert.equal(c.armorClass, 13);
  assert.equal(c.initiative, 1);
  assert.deepEqual(c.hp, { current: 19, max: 19, temp: null });
  assert.equal(c.speed, "30 ft.");
  assert.equal(c.proficiencyBonus, 2);
});

// ---------- Export API (Tampermonkey) ----------

test("oros.json (API) : identité, classe, monnaie, sorts", () => {
  const c = extractCharacter(orosJson, orosJsonPath);
  assert.equal(c.meta.source, "api");
  assert.equal(c.meta.characterId, "171883241");
  assert.equal(c.name, "Oros Telluros");
  assert.equal(c.race, "Earth Genasi");
  assert.deepEqual(c.classes, [{ name: "Druid", level: 2, subclass: null }]);
  assert.equal(c.alignment, "Neutral");
  assert.deepEqual(c.coins, { cp: 0, sp: 0, gp: 25, ep: 0, pp: 0 });

  assert.ok(c.equipment.some((e) => e.name === "Club"));
  assert.ok(c.features.some((f) => f.name === "Magic Initiate (Druid)"));

  const guidance = c.spells.find((s) => s.name === "Guidance");
  assert.ok(guidance, "Guidance devrait être dans les sorts");
  assert.equal(guidance.level, 0);
  assert.equal(guidance.castingTime, "1 Action");
  assert.equal(guidance.range, "Touch");

  // Les valeurs calculées viennent du DOM, pas de l'API
  assert.equal(c.armorClass, null);
  assert.equal(c.abilities.WIS.score, 0);
});

test("esther.json (API) : deuxième échantillon validant le mapping", () => {
  const c = extractCharacter(estherJson, estherJsonPath);
  assert.equal(c.name, "Esther Vaelis");
  assert.equal(c.race, "Half-Elf");
  assert.deepEqual(c.classes, [{ name: "Sorcerer", level: 2, subclass: null }]);
  assert.equal(c.alignment, "Neutral Good");
  assert.equal(c.equipment.length, 17);

  const cantrips = c.spells.filter((s) => s.level === 0);
  const level1 = c.spells.filter((s) => s.level === 1);
  assert.equal(cantrips.length, 3);
  assert.equal(level1.length, 4);
  assert.ok(c.spells.some((s) => s.name === "Chaos Bolt" && s.level === 1));
});

// ---------- Fusion multi-sources ----------

test("merge DOM + API (oros) : calculé du DOM, brut de l'API", () => {
  const c = extractCharacterFromSources([orosSpellsHtml, orosJson], ["oros-spells-tab.html", "oros.json"]);
  // Calculé par le DOM
  assert.deepEqual(c.abilities.WIS, { score: 16, modifier: 3 });
  assert.equal(c.armorClass, 13);
  assert.equal(c.initiative, 1);
  assert.deepEqual(c.savingThrows.WIS, { value: 5, proficient: true });
  // Brut de l'API
  assert.equal(c.name, "Oros Telluros");
  assert.equal(c.race, "Earth Genasi");
  assert.deepEqual(c.coins, { cp: 0, sp: 0, gp: 25, ep: 0, pp: 0 });
  assert.ok(c.spells.some((s) => s.name === "Guidance"));
  assert.ok(c.equipment.some((e) => e.name === "Club"));
});

test("un fichier qui n'est pas une fiche D&D Beyond produit une erreur claire", () => {
  assert.throws(
    () => extractCharacter("<html><body><p>pas une fiche</p></body></html>", "autre.html"),
    /Aucun personnage détecté/,
  );
});

// ---------- Demi-maîtrise (Jack of All Trades) — DOM Damaia ----------

const damaiaHtmlPath = join(here, "..", "samples", "damaia.html");
const damaiaHtml = readFileSync(damaiaHtmlPath, "utf8");
const damaiaJson = readFileSync(join(here, "..", "samples", "damaia.json"), "utf8");

test("damaia.html (DOM) : 13 compétences en demi-maîtrise reconnues", () => {
  const c = extractFromDom(damaiaHtml, damaiaHtmlPath, new Date().toISOString());
  const half = c.skills.filter((s) => s.proficiency === "half");
  assert.equal(half.length, 13);
  // Valeur = mod. carac + floor(PB/2) ; History : INT 0 + 1 = 1
  const history = c.skills.find((s) => s.name === "History");
  assert.equal(history.ability, "INT");
  assert.equal(history.value, 1);
  assert.equal(history.proficiency, "half");
  // Deception : CHA +3 + 1 = 4
  const deception = c.skills.find((s) => s.name === "Deception");
  assert.equal(deception.proficiency, "half");
  assert.equal(deception.value, 4);
});

test("damaia.html (DOM) : expertise sans aria-label reconnue via classe ddbc-*", () => {
  const c = extractFromDom(damaiaHtml, damaiaHtmlPath, new Date().toISOString());
  // Performance : +7 = CHA 3 + 2×PB — l'icône double n'a pas d'aria-label,
  // la classe ddbc-twice-proficiency du <svg> fait foi.
  const performance = c.skills.find((s) => s.name === "Performance");
  assert.equal(performance.proficiency, "expertise");
  assert.equal(performance.value, 7);
});

// ---------- Dés de vie (dans les captures sans hitPointInfo) ----------

test("damaia.json (API) : hitDice calculé depuis classes[].level × hitDice", () => {
  // DDB ne stocke jamais "2d8" sans difficulter : definition.hitDice = 8
  // et le nombre vient du niveau (2). Le capture Tampermonkey n'a pas de
  // hitPointInfo — le repli classes[] doit prendre le relais.
  const c = extractCharacterFromSources([damaiaJson], ["damaia.json"]);
  assert.equal(c.hitDice, "2d8");
  assert.equal(c.level, 2);
});

// ---------- Maîtrises d'armes / armures / outils (modifiers) ----------

test("damaia.json (API) : maîtrises d'armes et armures depuis modifiers", () => {
  const c = extractCharacter(damaiaJson, "damaia.json");
  assert.deepEqual(c.proficiencies.weapons, ["Simple Weapons"]);
  assert.deepEqual(c.proficiencies.armor, ["Light Armor"]);
  // Les instruments de choix du barde (granted=false) ne sont pas des maîtrises
  assert.deepEqual(c.proficiencies.tools, []);
});

test("elowen.json (API) : armes individuelles maîtrisées depuis modifiers", () => {
  const c = extractCharacter(elowenJson, "elowen.json");
  assert.ok(c.proficiencies.weapons.includes("Simple Weapons"));
  for (const weapon of ["Rapier", "Shortsword", "Scimitar", "Whip"]) {
    assert.ok(c.proficiencies.weapons.includes(weapon), `${weapon} devrait être maîtrisée`);
  }
  assert.ok(c.proficiencies.tools.includes("Thieves' Tools"));
});

// ---------- Taille de créature ----------

test("oros.json (API) : taille Medium depuis race.sizeId", () => {
  const c = extractCharacter(orosJson, "oros.json");
  assert.equal(c.size, "Medium");
});

test("damaia.json (API) : taille « Medium or Small » (espèce 2024)", () => {
  const c = extractCharacter(damaiaJson, "damaia.json");
  assert.equal(c.size, "Medium or Small");
});

// ---------- Attaques d'armes équipées ----------

test("damaia.json (API) : attaque avec bonus calculé, dégâts, propriétés", () => {
  const c = extractCharacter(damaiaJson, "damaia.json");
  const rapier = c.attacks.find((a) => a.name === "Rapier");
  assert.ok(rapier, "la Rapière équipée devrait être dans les attaques");
  // Arme de finesse : DEX +2 ; pas de maîtrise martiale → pas de PB
  assert.equal(rapier.bonus, "+2");
  assert.equal(rapier.damage, "1d8+2 Piercing");
  assert.equal(rapier.properties, "5 ft., Finesse, Vex");
  const dagger = c.attacks.find((a) => a.name === "Dagger");
  assert.ok(dagger);
  // Arme simple : maîtrisée → DEX +2 + PB 2
  assert.equal(dagger.bonus, "+4");
  assert.equal(dagger.damage, "1d4+2 Piercing");
  // Les non-maîtrisées main-nue / non équipées n'apparaissent pas
  assert.ok(!c.attacks.some((a) => a.name === "Leather"));
});

test("elowen.json (API) : attaque à distance avec maîtrise individuelle", () => {
  const c = extractCharacter(elowenJson, "elowen.json");
  const crossbow = c.attacks.find((a) => a.name === "Crossbow, Hand");
  assert.ok(crossbow);
  // DEX +3 + PB 2 (maîtrise individuelle : entityId = baseItemId de l'arme)
  assert.equal(crossbow.bonus, "+5");
  assert.equal(crossbow.damage, "1d6+3 Piercing");
  assert.equal(crossbow.properties, "30/120 ft., Ammunition, Range, Light, Loading, Vex");
});

// ---------- Sorts issus des traits / dons, et emplacements ----------

test("damaia.json (API) : cantrips de race (Fire Bolt, Thaumaturgy) dans les sorts", () => {
  const c = extractCharacter(damaiaJson, "damaia.json");
  assert.ok(c.spells.some((s) => s.name === "Fire Bolt" && s.level === 0), "Fire Bolt (Fiendish Legacy)");
  assert.ok(c.spells.some((s) => s.name === "Thaumaturgy" && s.level === 0));
  // Les sorts de classe restent présents (7 connus via classSpells)
  assert.ok(c.spells.some((s) => s.name === "Tasha's Hideous Laughter" && s.level === 1));
});

test("oros.json (API) : sorts de don (Magic Initiate) et de race inclus", () => {
  const c = extractCharacter(orosJson, "oros.json");
  assert.ok(c.spells.some((s) => s.name === "Mold Earth" && s.level === 0));
  assert.ok(c.spells.some((s) => s.name === "Message" && s.level === 0));
  assert.ok(c.spells.some((s) => s.name === "Pass without Trace" && s.level === 2));
  // Pas de doublon Message (data.spells.feat et rien d'autre) — 14 sorts au total
  assert.equal(c.spells.filter((s) => s.name === "Message").length, 1);
});

test("emplacements : full casters niv. 2 → 3 slots de niveau 1, rien au-delà", () => {
  for (const [json, label] of [[damaiaJson, "damaia"], [orosJson, "oros"], [estherJson, "esther"], [elowenJson, "elowen (aucun)"]] as [string, string][]) {
    const c = extractCharacter(json, label);
    const expected = label.includes("aucun") ? [] : [3];
    assert.deepEqual(c.spellSlots.slice(0, 3), expected, `slots ${label}`);
  }
});

// ---------- Défenses (résistances / immunités / vulnérabilités) ----------

test("damaia.json (API) : défenses depuis modifiers accordés (Tiefling → feu)", () => {
  const c = extractCharacterFromSources([damaiaJson], ["damaia.json"]);
  assert.deepEqual(c.defenses.resistances, [{ type: "resistance", value: "Fire" }]);
  assert.deepEqual(c.defenses.immunities, []);
  assert.deepEqual(c.defenses.vulnerabilities, []);
});

test("damaia.html (DOM) : défenses depuis le résumé « Defenses »", () => {
  const c = extractFromDom(damaiaHtml, damaiaHtmlPath, new Date().toISOString());
  assert.deepEqual(c.defenses.resistances, [{ type: "resistance", value: "Fire" }]);
});

// ---------- Lancement de sorts (mod / attack / saveDc) ----------

test("damaia.json (API) : spellcasting calculé (CHA +3, attack +5, DC 13)", () => {
  // Rien de tout fait dans le JSON : spellCastingAbilityId (6=CHA) + stat de
  // base (15) + bonus racial (+1) + PB depuis le niveau. Attack = mod+PB,
  // DC = 8+mod+PB — les mêmes valeurs que la page DDB affiche sur le tab spells.
  const c = extractCharacterFromSources([damaiaJson], ["damaia.json"]);
  assert.deepEqual(c.spellcasting, [
    { className: "Bard", ability: "CHA", modifier: 3, attack: 5, saveDc: 13 },
  ]);
});

test("oros.json (API) : spellcasting Druid (WIS +3, attack +5, DC 13)", () => {
  const c = extractCharacterFromSources([orosJson], ["oros.json"]);
  assert.deepEqual(c.spellcasting, [
    { className: "Druid", ability: "WIS", modifier: 3, attack: 5, saveDc: 13 },
  ]);
});

// ---------- Sorts : durée, portée en pieds, sorts de dégâts ----------

test("damaia.json (API) : durée formatée, portée en ft., marqueur dégâts", () => {
  const c = extractCharacterFromSources([damaiaJson], ["damaia.json"]);
  const fireBolt = c.spells.find((s) => s.name === "Fire Bolt");
  assert.equal(fireBolt?.range, "120 ft.");
  assert.equal(fireBolt?.damaging, true);
  assert.equal(fireBolt?.duration, "Instantané");
  assert.equal(c.spells.find((s) => s.name === "Disguise Self")?.duration, "1 Hour");
  assert.equal(c.spells.find((s) => s.name === "Dancing Lights")?.duration, "Conc. 1 Minute");
  assert.equal(c.spells.find((s) => s.name === "Cure Wounds")?.damaging, false);
});

test("inventaire : trié alphabétiquement, poids unitaire numérique (lb)", () => {
  const c = extractCharacterFromSources([damaiaJson], ["damaia.json"]);
  const names = c.equipment.map((e) => e.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));
  assert.equal(c.equipment.find((e) => e.name === "Backpack")?.weight, 5);
});

test("damaia.json (API) : unités méta et port de charge (FOR × 15 / × 30)", () => {
  const c = extractCharacterFromSources([damaiaJson], ["damaia.json"]);
  assert.deepEqual(c.meta.units, { distance: "ft.", weight: "lb." });
  // FOR effective 9 (8 de base + 1 ASI) → 135 lb, comme affiché par DDB
  assert.equal(c.carryingCapacity, 135);
  assert.equal(c.pushDragLift, 270);
});

test("damaia.json (API) : personnalité (traits/idéal/liens/défauts) extraite", () => {
  const c = extractCharacterFromSources([damaiaJson], ["damaia.json"]);
  assert.ok(c.personality?.traits[0].startsWith("Je refuse de passer inaperçue"));
  assert.ok((c.personality?.ideals[0] ?? "").includes("L'art et la beauté"));
  assert.ok((c.personality?.bonds[0] ?? "").includes("tante Lyra"));
  assert.ok((c.personality?.flaws[0] ?? "").includes("peur du rejet"));
  // data.traits.appearance (tenue, voix, attitude), ici absente du JSON
  assert.deepEqual(c.personality?.appearance, []);
});

console.log(`\n${passed} tests passés`);
