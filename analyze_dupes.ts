import { getConnection } from "./src/core/db.ts";

async function main() {
  try {
    const db = getConnection();
    
    const result = await db`SELECT slug FROM pages WHERE page_type = 'person' ORDER BY slug`;
    
    const slugs = (result || []).map((r: any) => r.slug);
    console.log(`Found ${slugs.length} person pages\n`);
    
    if (slugs.length === 0) {
      console.log("ERROR: No person pages found");
      process.exit(1);
    }
    
    // Build name map
    const nameMap = new Map<string, string[]>();
    for (const slug of slugs) {
      const name = slug.replace('people/', '');
      const parts = name.split('-');
      if (parts.length >= 2) {
        const key = `${parts[0]}-${parts[parts.length - 1]}`;
        if (!nameMap.has(key)) nameMap.set(key, []);
        nameMap.get(key)!.push(slug);
      }
    }
    
    // Find duplicates
    const dups: Array<{canonical: string; duplicate: string; conf: string}> = [];
    for (const [key, slugList] of nameMap) {
      if (slugList.length > 1) {
        const sorted = slugList.sort((a, b) => a.length - b.length);
        const canonical = sorted[0];
        for (let i = 1; i < sorted.length; i++) {
          const isPrefix = sorted[i].startsWith(canonical + '-');
          dups.push({
            canonical,
            duplicate: sorted[i],
            conf: isPrefix ? 'HIGH' : 'MEDIUM'
          });
        }
      }
    }
    
    // Sort HIGH confidence first
    dups.sort((a, b) => (b.conf === 'HIGH' ? 1 : -1) - (a.conf === 'HIGH' ? 1 : -1));
    
    console.log("=== SUSPECTED DUPLICATES (First 30) ===\n");
    for (const d of dups.slice(0, 30)) {
      console.log(`${d.canonical.padEnd(45)} -> ${d.duplicate.padEnd(50)} [${d.conf}]`);
    }
    
    console.log(`\nTotal: ${dups.length} duplicate pairs found`);
    process.exit(0);
    
  } catch (e: any) {
    console.error("Error:", e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

main();
