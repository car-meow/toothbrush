(function () {
    const DICTIONARY = new Set([
        "snow", "rider", "riders", "big", "flappy", "tower", "tiny", "square", "super", "mario",
        "sonic", "retro", "bowl", "subway", "surfer", "surfers", "slope", "run", "runner", "running",
        "temple", "tunnel", "road", "racing", "racer", "race", "speed", "drift", "drive", "driver",
        "car", "cars", "bike", "bikes", "moto", "wheelie", "park", "parkour", "escape", "room",
        "rooms", "craft", "mine", "miner", "mines", "drill", "clicker", "idle", "merge", "hero",
        "heroes", "legend", "legends", "world", "city", "island", "quest", "king", "queen", "ninja",
        "samurai", "dragon", "monster", "monsters", "zombie", "zombies", "shooter", "bubble", "blast",
        "battle", "soccer", "football", "basket", "basketball", "baseball", "golf", "tennis", "chess",
        "snake", "block", "blocks", "breaker", "smash", "smashy", "dash", "geometry", "vex", "lol",
        "io", "online", "classic", "deluxe", "remastered", "ultra", "turbo", "pro", "max", "mini",
        "little", "pixel", "gun", "guns", "tank", "war", "wars", "stick", "stickman", "man", "rise",
        "fall", "falling", "jump", "jumper", "jumping", "swing", "sword", "blaster", "storm", "rage",
        "mad", "crazy", "extreme", "ultimate", "zero", "one", "two", "three", "four", "five", "six",
        "seven", "eight", "nine", "ten", "among", "us", "paper", "duck", "life", "ducklife", "line",
        "beaver", "beavers",
        "golfing", "quests", "master", "masters", "fighter", "fighters", "arena", "arenas", "puzzle",
        "puzzles", "adventure", "adventures", "shark", "survival", "survivor", "survivors", "rocket",
        "league", "hoops", "slam", "jam", "pinball", "2048", "1v1", "3d", "2d", "x3m", "rrr"
    ]);

    function normalizeBookmarkFileName(name) {
        if (!name) return "";
        return name.includes(".") && name.lastIndexOf(".") > 0 ? name : `${name}.html`;
    }

    function stripBookmarkPrefixAndExtension(name) {
        let value = name || "";
        if (value.toLowerCase().startsWith("cl")) value = value.substring(2);
        if (value.toLowerCase().endsWith(".html")) value = value.substring(0, value.length - 5);
        return value;
    }

    function normalizeChunk(chunk) {
        return chunk
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/[_\-+]+/g, " ")
            .trim();
    }

    function getRecognizedToken(raw) {
        if (!raw) return null;
        if (/^\d+$/.test(raw)) return raw;
        if (DICTIONARY.has(raw)) return raw;
        if (raw.endsWith("s") && DICTIONARY.has(raw.slice(0, -1))) return raw;

        const repeatedTailMatch = raw.match(/^(.*?)(.)\2+$/);
        if (repeatedTailMatch) {
            const stem = `${repeatedTailMatch[1]}${repeatedTailMatch[2]}`;
            if (DICTIONARY.has(stem)) return raw;
        }

        return null;
    }

    function splitAlphaNumericChunk(chunk) {
        const lower = chunk.toLowerCase();
        const memo = new Map();

        function solve(index) {
            if (index === lower.length) return { score: 0, tokens: [] };
            if (memo.has(index)) return memo.get(index);

            let best = null;

            for (let end = index + 1; end <= lower.length; end++) {
                const part = lower.slice(index, end);
                const recognized = getRecognizedToken(part);
                if (!recognized) continue;

                const rest = solve(end);
                if (!rest) continue;

                const score = rest.score + part.length * 8 - 1;
                const candidate = { score, tokens: [part, ...rest.tokens] };
                if (!best || candidate.score > best.score) best = candidate;
            }

            memo.set(index, best);
            return best;
        }

        const result = solve(0);
        return result ? result.tokens : [lower];
    }

    function humanizeBookmarkDisplayName(name, stripExtension = false) {
        const raw = stripExtension ? stripBookmarkPrefixAndExtension(name) : stripBookmarkPrefixAndExtension(name);
        const normalized = normalizeChunk(raw);
        if (!normalized) return "";

        const tokens = normalized
            .split(/\s+/)
            .filter(Boolean)
            .flatMap(part => splitAlphaNumericChunk(part));

        return tokens.map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(" ").replace(/\s+/g, " ").trim();
    }

    function buildBookmarkSourceKey(name) {
        return `stash:${normalizeBookmarkFileName(name).toLowerCase()}`;
    }

    function buildBookmarkIdFromSourceKey(sourceKey) {
        return `bookmark_${encodeURIComponent(sourceKey)}`;
    }

    window.normalizeBookmarkFileName = normalizeBookmarkFileName;
    window.stripBookmarkPrefixAndExtension = stripBookmarkPrefixAndExtension;
    window.humanizeBookmarkDisplayName = humanizeBookmarkDisplayName;
    window.buildBookmarkSourceKey = buildBookmarkSourceKey;
    window.buildBookmarkIdFromSourceKey = buildBookmarkIdFromSourceKey;
})();
