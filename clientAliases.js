// ============================================================
// CLIENT ALIASES
// Canonical client name (exactly as in PMT `clients`) -> the short
// forms people type in WhatsApp. Add new ones here as needed.
// ============================================================

const CLIENT_ALIASES = {
    "ICICI Prudential Mutual Fund": ["icici prudential", "icici pru", "icici", "ipru"],
    "ICICI Prudential iSIF": ["icici isif", "ipru isif"],
    "ICICI Prudential Alternative": ["icici alternative", "ipru alternative"],
    "Aditya Birla Sun Life Mutual Fund": ["aditya birla sun life", "aditya birla", "absl"],
    "ABSL Apex SIF": ["absl apex"],
    "Aditya Birla Alternative": ["absl alternative", "aditya birla alternative"],
    "Baroda BNP Paribas": ["baroda bnp paribas", "baroda bnp", "bnp paribas", "bnp"],
    "Canara Robeco": ["canara robeco", "canara robecco", "canara"],
    "Invesco": ["invesco"],
    "Bandhan": ["bandhan"],
    "Thefinpedia": ["thefinpedia", "the finpedia", "tfp"],
    "Franklin Templeton": ["franklin templeton", "ft"],
    "FT Sapphire SIF": ["ft sapphire"],
    "Bajaj Finserv AMC": ["bajaj finserv", "bajaj"],
    "Nippon": ["nippon"],
    "Mirae Asset MF": ["mirae asset", "mirae"],
    "HDFC Mutual Fund": ["hdfc"],
    "SBI MF": ["sbi mf", "sbi"],
    "Motilal Oswal AMC": ["motilal oswal", "motilal"],
    "TATA AIA": ["tata aia"],
    "TATA MF": ["tata mf"],
    "360 ONE Asset": ["360 one", "360one"],
    "Nuvama Asset Management": ["nuvama"],
    "UTI MF": ["uti mf", "uti"],
    "Axis Mutual Fund": ["axis mf", "axis"],
    "PNB Housing": ["pnb housing", "pnb"],
    "Muthoot Housing Finance": ["muthoot"],
    "ASK Group": ["ask group"],
    "Sriram": ["shriram", "sriram"],
    "ITI MF": ["iti mf", "iti"],
    "FinAce": ["finace"],
    "HSBC": ["hsbc"],
    "Ecofy": ["ecofy"],
    "AMFI": ["amfi"],
    "NSE": ["nse"],
    "JIO": ["jio"]
};

// Clients that share a brand. When a line says only "ICICI" or "ABSL",
// a strong project match in a sibling client is allowed to win.
const CLIENT_FAMILIES = [
    ["CLIENT - 006", "CLIENT - 026", "CLIENT - 019"],   // ICICI Prudential MF / iSIF / Alternative
    ["CLIENT - 011", "CLIENT - 033", "CLIENT - 025"],   // ABSL MF / Apex SIF / Alternative
    ["CLIENT - 016", "CLIENT - 034"]                    // Franklin Templeton / FT Sapphire SIF
];

module.exports = { CLIENT_ALIASES, CLIENT_FAMILIES };
