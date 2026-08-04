import { seedCompaniesIfEmpty } from "../src/lib/seed";

seedCompaniesIfEmpty().then((n) => {
  console.log(`seed complete (${n} companies)`);
  process.exit(0);
});
