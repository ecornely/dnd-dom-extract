import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractCharacter, extractFromDom, findEmbeddedCharacters } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "mock-beyond-sheet.html");
const fixtureHtml = readFileSync(fixturePath, "utf8");

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("dnd-dom-extract — tests");

/**
 * Dump combiné synthétique au format v5 (le seul supporté) : responses[]
 * character-service + domHtml. Ici les réponses sont simulées à partir du
 * JSON embarqué du fixture ; les samples réels regénérés par le userscript
 * v5 serviront de vérité terrain au fil des personnages.
 */
function buildDump(overrides: Partial<{ responses: unknown[]; domHtml: string }> = {}): string {
  const embedded = findEmbeddedCharacters(fixtureHtml);
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    pageUrl: "https://www.dndbeyond.com/characters/12345678",
    count: 1,
    responses: [
      {
        capturedAt: new Date().toISOString(),
        transport: "fetch",
        status: 200,
        url: "https://character-service.dndbeyond.com/character/v5/character/12345678",
        // character-service renvoie le personnage racine : payload.data =
        // l'objet { name, classes, currencies, ... }, soit le .data interne
        // de characters["<id>"].
        payload: { data: ((embedded[0].data as { data?: unknown }).data ?? embedded[0].data) },
      },
    ],
    domHtml: fixtureHtml,
    ...overrides,
  });
}

// ---------- Validation du format (rejet de tout le reste) ----------

test("un contenu qui n'est pas l'export Tampermonkey v5 est rejeté avec un message clair", () => {
  assert.throws(
    () => extractCharacter("<html><body><p>pas un export</p></body></html>", "autre.html"),
    /n'est pas un export Tampermonkey v5/,
  );
  assert.throws(
    () => extractCharacter("{}", "vide.json"),
    /n'est pas un export Tampermonkey v5/,
  );
  // responses sans domHtml = ancien export v4 : refusé, un seul format
  const v4 = JSON.stringify({ responses: [] });
  assert.throws(() => extractCharacter(v4, "export-api.json"), /n'est pas un export Tampermonkey v5/);
});

test("plusieurs sources refusées par le CLI (le CLI n'accepte qu'un dump)", async () => {
  const { run } = await import("../src/cli.js");
  const result = run(["node", "cli", "a.json", "b.json"]);
  assert.equal(result.code, 1);
  assert.match(result.output ?? "", /Un seul fichier attendu/);
});

test("dump sans réponse character-service exploitable mais avec domHtml : extraction DOM seule", () => {
  const c = extractCharacter(buildDump({ responses: [] }), "dump-sans-api.json");
  assert.equal(c.meta.source, "dom");
  assert.equal(c.name, "Oros Telluros");
  assert.equal(c.armorClass, 13);
});

test("dump avec domHtml vide : extraction API seule", () => {
  const c = extractCharacter(buildDump({ domHtml: "" }), "dump-sans-dom.json");
  assert.equal(c.meta.source, "api");
  // Le JSON embarqué du fixture met name/xp sur l'objet externe
  // characters["<id>"], pas dans le payload racine character-service.
  assert.equal(c.name, null);
  assert.equal(c.meta.characterId, "12345678");
  assert.equal(c.armorClass, null);
  assert.deepEqual(c.coins, { cp: 10, sp: 5, ep: 0, gp: 25, pp: 0 });
});

// ---------- Extraction du JSON embarqué (canaux historiques) ----------

test("findEmbeddedCharacters extrait le JSON malgré les accolades dans les chaînes", () => {
  const found = findEmbeddedCharacters(fixtureHtml);
  assert.equal(found.length, 1);
  assert.equal(found[0].characterId, "12345678");
  const name = (found[0].data as { name?: string }).name;
  assert.equal(name, "Damaia Dread");
});

// ---------- Ancres textuelles (domHtml) ----------

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

// ---------- Dump combiné v5 : API + DOM dans un seul fichier ----------

test("export v5 (responses + domHtml) : calculé du DOM, brut de l'API, fusion sans écrasement", () => {
  const c = extractCharacter(buildDump(), "export.json");
  // Valeurs calculées, issues du domHtml
  assert.deepEqual(c.abilities.CHA, { score: 8, modifier: -1 });
  assert.deepEqual(c.abilities.STR, { score: 13, modifier: 1 });
  assert.equal(c.armorClass, 13);
  assert.equal(c.initiative, 1);
  assert.deepEqual(c.savingThrows.STR, { value: 1, proficient: true });
  assert.deepEqual(c.skills.find((s) => s.name === "Animal Handling"), {
    name: "Animal Handling",
    ability: "WIS",
    value: 3,
    proficiency: "proficient",
  });
  assert.deepEqual(c.hp, { current: 19, max: 19, temp: null });
  assert.equal(c.speed, "30 ft.");
  assert.equal(c.proficiencyBonus, 2);
  // Données brutes, issues des réponses API (le merged meta est celui du DOM)
  assert.equal(c.meta.source, "dom");
  assert.equal(c.name, "Oros Telluros"); // le DOM prime pour le nom affiché
  assert.equal(c.race, "Earth Genasi");
  assert.deepEqual(c.classes, [{ name: "Druid", level: 2, subclass: null }]);
  assert.deepEqual(c.coins, { cp: 10, sp: 5, ep: 0, gp: 25, pp: 0 });
  assert.equal(c.background, "Charlatan");
});

console.log(`\n${passed} tests passés`);
