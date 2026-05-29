#!/usr/bin/env bun
/**
 * Bulk-inserts Bible story topics into the D1 topics_queue.
 *
 * Usage:
 *   bun run scripts/add-topics.ts --preview   (list without inserting)
 *   bun run scripts/add-topics.ts             (insert into D1)
 *   make topics                               (prompts for confirmation)
 */

const TOPICS: Array<{ topic: string; priority: number }> = [
  // Priority 10 — all-time classics every child knows
  { topic: "Creation of the World in Seven Days",              priority: 10 },
  { topic: "Noah and the Rainbow Promise",                     priority: 10 },
  { topic: "David and Goliath",                               priority: 10 },
  { topic: "Moses Leads the Israelites Through the Red Sea",  priority: 10 },
  { topic: "Jonah and the Big Fish",                          priority: 10 },
  { topic: "The Birth of Jesus in Bethlehem",                 priority: 10 },
  { topic: "Jesus Feeds Five Thousand People",                priority: 10 },
  { topic: "The Prodigal Son Returns Home",                   priority: 10 },
  { topic: "Daniel in the Lions Den",                         priority: 10 },
  { topic: "Joseph and His Colorful Coat",                    priority: 10 },

  // Priority 9
  { topic: "The Good Samaritan",                              priority: 9 },
  { topic: "Zacchaeus Climbs a Tree to See Jesus",            priority: 9 },
  { topic: "Jesus Walks on Water",                            priority: 9 },
  { topic: "The Three Friends in the Fiery Furnace",          priority: 9 },
  { topic: "Esther Saves Her People",                         priority: 9 },
  { topic: "The Lost Sheep and the Caring Shepherd",          priority: 9 },
  { topic: "Palm Sunday — Jesus Enters Jerusalem",            priority: 9 },
  { topic: "Easter Morning — The Empty Tomb",                 priority: 9 },
  { topic: "Jesus and the Children Come to Me",               priority: 9 },
  { topic: "Pentecost — The Holy Spirit Comes",               priority: 9 },

  // Priority 8
  { topic: "Adam and Eve in the Garden of Eden",              priority: 8 },
  { topic: "The Tower of Babel",                              priority: 8 },
  { topic: "Abraham and God's Promise of Stars",              priority: 8 },
  { topic: "Elijah and the Still Small Voice",                priority: 8 },
  { topic: "Ruth and Naomi's Faithful Journey",               priority: 8 },
  { topic: "Hannah's Prayer for a Baby",                      priority: 8 },
  { topic: "David Becomes King of Israel",                    priority: 8 },
  { topic: "Elisha and the Widow's Oil",                      priority: 8 },
  { topic: "Jesus Heals the Blind Bartimaeus",                priority: 8 },
  { topic: "Jesus Raises Lazarus from the Dead",              priority: 8 },
  { topic: "The Parable of the Mustard Seed",                 priority: 8 },
  { topic: "Paul's Road to Damascus",                         priority: 8 },
  { topic: "The Wedding at Cana — Water into Wine",           priority: 8 },
  { topic: "Jesus Calms the Storm",                           priority: 8 },
  { topic: "The Last Supper",                                 priority: 8 },

  // Priority 7
  { topic: "The Burning Bush Calls Moses",                    priority: 7 },
  { topic: "Joshua and the Battle of Jericho",               priority: 7 },
  { topic: "Samson and the Lion",                             priority: 7 },
  { topic: "King Solomon Builds the Temple",                  priority: 7 },
  { topic: "Nehemiah Rebuilds the City Walls",               priority: 7 },
  { topic: "Elijah and the Contest on Mount Carmel",         priority: 7 },
  { topic: "John the Baptist Prepares the Way",              priority: 7 },
  { topic: "Jesus Baptism in the River Jordan",              priority: 7 },
  { topic: "The Sermon on the Mount",                        priority: 7 },
  { topic: "Peter Walks on Water",                           priority: 7 },
  { topic: "The Parable of the Ten Talents",                 priority: 7 },
  { topic: "The Parable of the Pearl of Great Price",        priority: 7 },
  { topic: "Jesus Heals Ten Lepers",                         priority: 7 },
  { topic: "The Wise and Foolish Builders",                  priority: 7 },
  { topic: "Naaman Is Healed in the River",                  priority: 7 },

  // Priority 6
  { topic: "Jacob's Dream of a Stairway to Heaven",          priority: 6 },
  { topic: "Isaac and Rebekah",                              priority: 6 },
  { topic: "Moses Receives the Ten Commandments",            priority: 6 },
  { topic: "Manna — Bread from Heaven in the Desert",        priority: 6 },
  { topic: "Gideon and the Fleece",                          priority: 6 },
  { topic: "Samuel Hears God's Voice",                       priority: 6 },
  { topic: "Elijah Fed by Ravens in the Desert",             priority: 6 },
  { topic: "The Good Shepherd — Psalm 23",                   priority: 6 },
  { topic: "Jesus at the Temple as a Boy",                   priority: 6 },
  { topic: "Philip and the Ethiopian",                       priority: 6 },
];

const args = process.argv.slice(2);
const preview = args.includes("--preview");

if (preview) {
  console.log(`\nTopics to add (${TOPICS.length} total):\n`);
  const byPriority = [...TOPICS].sort((a, b) => b.priority - a.priority);
  for (const t of byPriority) {
    console.log(`  [${t.priority}] ${t.topic}`);
  }
  console.log("\nRun without --preview to insert into D1.");
  process.exit(0);
}

import { unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cfDir = join(here, "..", "cloudflare");

const values = TOPICS.map(
  (t) => `('${t.topic.replace(/'/g, "''")}', ${t.priority})`,
).join(",\n  ");

const sql = [
  `INSERT OR IGNORE INTO topics_queue (topic, priority) VALUES`,
  `  ${values};`,
  ``,
  `SELECT COUNT(*) as total,`,
  `       CAST(SUM(used) AS INTEGER) as used,`,
  `       COUNT(*)-CAST(SUM(used) AS INTEGER) as remaining`,
  `FROM topics_queue;`,
].join("\n");

const sqlFile = join("/tmp", `add-topics-${Date.now()}.sql`);
writeFileSync(sqlFile, sql);

console.log(`\nInserting ${TOPICS.length} topics into D1...\n`);

const proc = Bun.spawn(
  ["npx", "wrangler", "d1", "execute", "bible-videos-series-memory",
   "--file", sqlFile, "--remote"],
  { cwd: cfDir, stdout: "inherit", stderr: "inherit" },
);
const code = await proc.exited;
try { unlinkSync(sqlFile); } catch {}
process.exit(code);
