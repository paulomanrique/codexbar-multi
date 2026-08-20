defineProvider({
  id: "cli-fixture",
  name: "CLI Fixture",
  endpoints: ["https://api.example.test"],
  settings: [],
  async fetchUsage() {
    return { primary: { usedPercent: 42 } };
  },
});
