globalThis.YCIF_SCORE = (() => {
  const N = globalThis.YCIF_NAMES;

  const norm = (s) =>
    String(s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/'/g, "")
      .replace(/[^a-z\s-]/g, " ");

  const tokens = (s) => norm(s).split(/[\s-]+/).filter((t) => t.length > 1);
  const toSet = (...parts) => new Set(parts.flatMap((p) => tokens(p)));

  const KEYWORDS = [
    ["IIT", /\bIIT\b|\bIIT[\s-][A-Z][a-z]+|Indian Institute of Technology/],
    ["IIM", /\bIIM\b|Indian Institute of Management/],
    ["IISc", /\bIISc\b|Indian Institute of Science/],
    ["IIIT", /\bIIIT\b/],
    ["BITS", /\bBITS\b/],
    ["NIT", /\bNIT\b|National Institute of Technology/],
    ["ISB", /\bISB\b|Indian School of Business/],
    ["Indian college", /\b(DTU|NSIT|VIT|COEP|NMIMS|Manipal|Jadavpur|Anna University|Delhi University|University of (Delhi|Mumbai|Pune|Hyderabad|Calcutta)|PES University|RV College|BMS College|Ashoka University|Christ University|SRM)\b/],
    ["India", /\bIndia\b|\bIndian\b/],
    ["Indian city", /\b(Bangalore|Bengaluru|Mumbai|Bombay|New Delhi|Delhi|Hyderabad|Chennai|Pune|Kolkata|Calcutta|Gurgaon|Gurugram|Noida|Ahmedabad|Jaipur|Kochi|Chandigarh|Indore|Lucknow)\b/i],
    ["Indian startup", /\b(Flipkart|Swiggy|Zomato|Razorpay|Paytm|Infosys|Wipro|Zerodha|Meesho|PhonePe|Unacademy|BYJU'?S|Freshworks|Zoho|InMobi|Dream11|Groww|Ola Cabs|Myntra|Nykaa|Zepto|Blinkit|Urban Company)\b/],
  ];

  let sets;

  function configure(extra = {}) {
    sets = {
      strongLast: toSet(N.strongSurnames, extra.surnames),
      ambigLast: toSet(N.ambiguousSurnames),
      weakLast: toSet(N.weakSurnames),
      strongFirst: toSet(N.strongFirstNames, extra.firstNames),
      ambigFirst: toSet(N.ambiguousFirstNames),
    };
  }

  function keywordHits(text) {
    if (!text) return [];
    return KEYWORDS.filter(([, re]) => re.test(text)).map(([label]) => label);
  }

  function score({ first, last, region, bio, companyLocation }) {
    const reasons = [];
    let s = 0;
    const f = tokens(first);
    const l = tokens(last);
    if (!l.length && f.length > 1) l.push(f.pop());
    const firstName = f[0];
    const lastName = l[l.length - 1];
    const middle = [...f.slice(1), ...l.slice(0, -1)];

    let firstHit = 0;
    if (firstName && sets.strongFirst.has(firstName)) {
      s += 2;
      firstHit = 2;
      reasons.push(`first name ${firstName}`);
    } else if (firstName && sets.ambigFirst.has(firstName)) {
      s += 1;
      firstHit = 1;
      reasons.push(`first name ${firstName} (also common elsewhere)`);
    }

    if (lastName && lastName !== firstName) {
      if (sets.strongLast.has(lastName)) {
        s += 3;
        reasons.push(`surname ${lastName}`);
      } else if (sets.ambigLast.has(lastName)) {
        s += 2;
        reasons.push(`surname ${lastName} (South Asian, not India-specific)`);
      } else if (sets.weakLast.has(lastName) && firstHit) {
        s += 1;
        reasons.push(`surname ${lastName} with Indian first name`);
      }
    }

    const mid = middle.find((t) => sets.strongLast.has(t) || sets.strongFirst.has(t));
    if (mid) {
      s += 1;
      reasons.push(`middle name ${mid}`);
    }

    const hits = keywordHits(bio);
    if (hits.length) {
      s += 2;
      reasons.push(`bio: ${hits.slice(0, 3).join(", ")}`);
    }

    const inIndia = /\bindia\b/i.test(region || "") || /\bindia\b/i.test(companyLocation || "");
    if (inIndia) {
      s += 1;
      reasons.push("based in India");
    }

    const tier = s >= 4 ? "high" : s >= 2 ? "medium" : s >= 1 ? "low" : "none";
    return { score: s, tier, reasons, inIndia };
  }

  configure();
  return { configure, score, keywordHits, tokens };
})();
