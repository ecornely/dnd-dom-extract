import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractCharacter, extractFromDom, findEmbeddedCharacters, loadExtractRules, mapActions, mapActionsFromDom, normalizeExtractRules, sourcesFromDump } from "../src/index.js";

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

// ---------- Actions (tab Actions DDB) : mapping JSON (repli) ----------

test("mapActions (JSON, repli) : noms groupés par activationType, doublons et custom inclus", () => {
  const dump = JSON.parse(buildDump()) as {
    responses: { payload: { data: Record<string, unknown> } }[];
  };
  dump.responses[0].payload.data.actions = {
    class: [
      { name: "Sneak Attack", activation: { activationType: 8 } },
      { name: "Cunning Action", activation: { activationType: 2 } },
    ],
    race: [{ name: "Hellish Rebuke", activation: { activationType: 3 } }],
    background: null,
    item: [{ name: "Chance écrasante", activation: { activationType: 1 } }],
  };
  dump.responses[0].payload.data.customActions = [
    { name: "Chance écrasante", activation: { activationType: 1 } },
  ];

  assert.deepEqual(mapActions(dump.responses[0].payload.data), {
    action: ["Chance écrasante"],
    bonusAction: ["Cunning Action"],
    reaction: ["Hellish Rebuke"],
    other: ["Sneak Attack"],
  });
  assert.deepEqual(mapActions({}), { action: [], bonusAction: [], reaction: [], other: [] });
});

// ---------- Actions (tab Actions DDB) : le DOM de la feuille prime ----------

test("mapActionsFromDom : groupage de la feuille, standards écartés, annotations nettoyées", () => {
  assert.deepEqual(mapActionsFromDom(fixtureHtml), {
    action: [], // Unarmed Strike / Attack / Dash : standard, écartés
    bonusAction: ["Two-Weapon Fighting", "Wild Shape"],
    reaction: ["Absorb Elements"], // le sort réaction caché dans Spells
    other: ["Sneak Attack"], // annotation (Special) nettoyée
  });
});

test("export v5 : les actions du DOM priment sur le JSON (erreur d'activation + contenu non possédé)", () => {
  // Le payload character-service place Wild Shape en activationType réaction
  // et expose des entrées « Circle Spell » venant de livres non possédés ;
  // la feuille (domHtml) les corrige/filtre toutes les deux.
  const dump = JSON.parse(buildDump()) as {
    responses: { payload: { data: Record<string, unknown> } }[];
  };
  dump.responses[0].payload.data.actions = {
    class: [
      { name: "Wild Shape", activation: { activationType: 3 } }, // serait une réaction côté JSON
      { name: "Circle Spell: Augment", activation: { activationType: 8 } },
    ],
  };
  const c = extractCharacter(JSON.stringify(dump), "export.json");
  assert.deepEqual(c.actions, {
    action: [],
    bonusAction: ["Two-Weapon Fighting", "Wild Shape"],
    reaction: ["Absorb Elements"],
    other: ["Sneak Attack"],
  });
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

// ---------- Règles de filtrage (rules.json : contenu de campagne non affiché) ----------

/** Dump avec feats (dont du contenu de campagne) + réponse rule-data. */
function buildDumpWithFeats(): string {
  const dump = JSON.parse(buildDump()) as {
    responses: { payload: { data: Record<string, unknown> } }[];
  };
  const feat = (name: string, sourceId: number) => ({
    componentTypeId: 67468084,
    componentId: 0,
    definitionId: 0,
    definition: { id: sourceId, name, sources: [{ sourceId, sourceType: 1 }] },
  });
  dump.responses[0].payload.data.feats = [
    feat("Great Weapon Fighting", 145), // PHB 2024 : affiché par la feuille
    feat("Dark Bargain", 193), // campagne : jamais rendu par la feuille
    feat("Runestones", 239),
  ];
  dump.responses.push({
    url: "https://character-service.dndbeyond.com/character/v5/rule-data?v=test",
    status: 200,
    payload: {
      data: {
        sources: [
          { id: 145, name: "PHB-2024", description: "Player’s Handbook" },
          { id: 193, name: "TCMP1", description: "The Crooked Moon Part One" },
          { id: 239, name: "NS", description: "Northlands Sagas" },
        ],
      },
    },
  });
  return JSON.stringify(dump);
}

const CAMPAIGN_RULES = { excludeFeatureSources: ["TCMP1", "NWB", "NS"] };

test("extractCharacter sans règles : tous les feats (comportement par défaut inchangé)", () => {
  const c = extractCharacter(buildDumpWithFeats(), "export.json");
  assert.deepEqual(
    c.features.map((f) => f.name),
    ["Great Weapon Fighting", "Dark Bargain", "Runestones"],
  );
});

test("extractCharacter avec excludeFeatureSources : les feats de campagne sont écartés", () => {
  const c = extractCharacter(buildDumpWithFeats(), "export.json", { rules: CAMPAIGN_RULES });
  assert.deepEqual(c.features.map((f) => f.name), ["Great Weapon Fighting"]);
});

test("extractCharacter avec excludeFeatures : filtre par nom, quel que soit l'ouvrage", () => {
  const c = extractCharacter(buildDumpWithFeats(), "export.json", {
    rules: { excludeFeatures: ["dark bargain"] },
  });
  assert.deepEqual(c.features.map((f) => f.name), ["Great Weapon Fighting", "Runestones"]);
});

test("un feat sans source résolue ou sans sources passe toujours (pas de filtre par excès)", () => {
  const dump = JSON.parse(buildDump()) as {
    responses: { payload: { data: Record<string, unknown> } }[];
  };
  dump.responses[0].payload.data.feats = [
    { definition: { name: "Mystery Feat", sources: [{ sourceId: 999999 }] } },
    { definition: { name: "Sourceless Feat", sources: [] } },
  ];
  const c = extractCharacter(JSON.stringify(dump), "export.json", { rules: CAMPAIGN_RULES });
  assert.deepEqual(c.features.map((f) => f.name), ["Mystery Feat", "Sourceless Feat"]);
});

test("sourcesFromDump lit la réponse rule-data ; absente = map vide", () => {
  const dump = JSON.parse(buildDumpWithFeats()) as import("../src/index.js").ApiExport;
  assert.equal(sourcesFromDump(dump).get(145)?.name, "PHB-2024");
  const emptyDump = JSON.parse(buildDump()) as import("../src/index.js").ApiExport;
  assert.equal(sourcesFromDump(emptyDump).size, 0);
});

test("normalizeExtractRules rejette les clés inconnues et les listes invalides", () => {
  assert.deepEqual(normalizeExtractRules({}), { excludeFeatureSources: [], excludeFeatures: [] });
  assert.throws(() => normalizeExtractRules({ excludeOther: [] }), /clé inattendue/);
  assert.throws(() => normalizeExtractRules({ excludeFeatures: [42] }), /liste de chaînes/);
});

test("loadExtractRules : erreur claire sur un fichier absent ou invalide", () => {
  assert.throws(() => loadExtractRules(join(here, "inexistant.json")), /Impossible de lire le fichier de règles/);
});

console.log(`\n${passed} tests passés`);
