// nexus-version: 4.47.13
(function () {
    const DICTIONARY = new Set((`
        snow rider riders big flappy tower tiny square super mario sonic retro bowl subway surfer surfers
        slope run runner running temple tunnel road racing racer race speed drift drive driver car cars bike
        bikes moto wheelie park parkour escape room rooms craft mine miner mines drill clicker idle merge hero
        heroes legend legends world city island quest king queen ninja samurai dragon monster monsters zombie
        zombies shooter bubble blast battle soccer football basket basketball baseball golf tennis chess snake
        block blocks breaker smash smashy dash geometry vex lol io online classic deluxe remastered ultra turbo
        pro max mini little pixel gun guns tank war wars stick stickman man rise fall falling jump jumper jumping
        swing sword blaster storm rage mad crazy extreme ultimate zero one two three four five six seven eight
        nine ten among us paper duck life ducklife line beaver beavers golfing quests master masters fighter
        fighters arena arenas puzzle puzzles adventure adventures shark survival survivor survivors rocket league
        hoops slam jam pinball 2048 1v1 3d 2d x3m rrr at the of a an and in on to for with vs from by is
        night nights freddy freddys fnaf baldi baldis five friday thirteen halloween horror scary spooky haunted
        mansion house granny grandma grandpa sister brother neighbor neighbors school teacher escape simulator
        simulation tycoon manager builder building idle clicker factory farm farming farmer village kingdom
        kingdoms empire empires castle dungeon tower defense defender defenders attack attackers strike striker
        fight fighting fighter brawler beat em up arcade platform platformer adventure quest racer kart drift
        racing sports sport soccer football fifa basketball baseball hockey cricket volleyball tennis golf bowling
        pool billiards skate skating snowboard snowboarding surfing skateboard bike bicycle motocross motorcycle
        truck trucks bus train plane flight airplane airport ship boat submarine spaceflight space astronaut
        galaxy planet planets solar system alien aliens robot robots mech monster monster hunter dragon dragons
        pokemon pokedex pocket animal animals pet pets cat cats dog dogs puppy kitten farm zoo safari dinosaur
        dinosaurs jurassic ocean underwater fish shark whale ocean water submarine island islander pirate pirates
        treasure gold coin coins gems jewel jewelers diamond diamonds crystal crystals magic wizard witch spell
        spells potion potions alchemy vampire vampires zombie zombies undead skeletons skeleton ghost ghosts
        demon demons devil angel angels god gods myth mythology legend legends hero heroes villain villains
        superhero superheroes comic comics marvel avengers batman superman spiderman spider man iron hulk thor
        warcraft starcraft craft minecraft roblox fortnite pubg counter strike valorant overwatch battlefield
        call duty modern warfare black ops grand theft auto gta red dead redemption elder scrolls skyrim fallout
        borderlands bioshock portal half life team fortress left dead resident evil silent hill metal gear final
        fantasy kingdom hearts mario kart super smash bros donkey kong kirby metroid zelda legend zelda sonic
        hedgehog crash bandicoot spyro ratchet clank sly cooper littlebigplanet sackboy playstation nintendo
        xbox atari sega gameboy gamecube wii switch ds pc windows mobile online multiplayer singleplayer co-op
        versus arena royale battle royale tower defense wave waves rush survival island desert forest jungle
        woods mountain mountains cave caves mines dungeon dungeons maze mazes labyrinth labyrinths puzzle puzzles
        brain brainy logic match matching merge merging connect connected color colors colour colored paint painter
        draw drawing sketch design fashion dress up makeover makeup salon cooking cook chef restaurant food pizza
        burger sandwich sushi noodle ramen cake cookie candy chocolate sweet sugar ice cream fruit vegetable
        garden gardening plant plants tree trees flower flowers harvest harvesters fishing fish fisherman
        hunter hunting sniper gunner shooter shooting bullet bullets buckshot roulette revolver pistol rifle
        shotgun weapons weapon combat warfare battlefront frontline frontlines command commander general army
        navy airforce soldier soldiers commando tactical strategy tactics turn-based card cards deck solitaire
        poker blackjack slots slot machine dice domino dominoes board tabletop chess checkers draughts go
        racing driver drift driving carx asphalt need speed burnout forza gran turismo rally formula f1 nascar
        football manager championship league cup world cup champions championsleague superleague premier league
        hoops dunk dunker slam jam basketball stars soccer stars head headball volley tennis ace golf clash
        baseball stars cricket stars bowling alley pool party party games fall guys among us impostor imposter
        crewmate crew mates goose goosegame duck ducklings silly goofy funny goofy ahh wacky weird strange
        crazy mad insane impossible difficult hard easy casual relaxing calm zen classic retro pixel art 8bit
        16bit low poly three dimensional first person third person top down side scroller endless runner
        parkour platform climb climbing climber jumper hopper hop bounce bouncing ball balls brick bricks
        breakout arkanoid bubble shooter bubble shooter bubble pop bubble pops popper match three match3
        connect four tic tac toe sudoku word words search crossword spelling typing quiz trivia brain test
        brain out brain it draw climb hill climb hillclimb stick war stickman hook rope swing ragdoll rag dolls
        physics sandbox simulator simulator tycoon clicker idle miner gold miner cookie clicker cow clicker
        five nights at baldis baldi basics nights freddy fazbears pizzeria animatronic animatronics
        minute minutes til till dawn redone remastered remake reboot origins origin chronicles chronicles
        shrek shreks yoshi yoshis epstein epsteins frick bears hotel
        stories story tale tales saga adventure adventures chapter chapters episode episodes part one two three
        ultimate edition collection complete definitive anniversary legacy legends rising returns revenge
        reloaded unleashed showdown tournament champions championship battle royale duels duel survival
        endless infinite mega micro super ultra hyper turbo nitro extreme pro plus new old happy wheels wheel
        wheels happy farm tiny fishing idle breakout idle mining deep mine road rage crazy games game games
        buckshot roulette fifa fiveminutes five nights baldis roulette
    `).trim().toLowerCase().split(/\s+/));
    const WORD_FREQUENCY = new Map(Array.from(DICTIONARY, word => [word, 1]));

    const MINOR_TITLE_WORDS = new Set([
        "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "vs", "with"
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
            .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/([A-Za-z])(\d)/g, "$1 $2")
            .replace(/(\d)([A-Za-z])/g, "$1 $2")
            .replace(/[_\-+]+/g, " ")
            .trim();
    }

    function rememberWord(word) {
        const normalized = String(word || "").toLowerCase();
        if (!/^[a-z][a-z0-9']{1,13}$/.test(normalized)) return;
        WORD_FREQUENCY.set(normalized, (WORD_FREQUENCY.get(normalized) || 0) + 1);
    }

    // Existing multiword titles provide a Stash-specific vocabulary. Camel-case
    // file names add further words without treating whole run-together titles as words.
    function configureGameTitleVocabulary(games) {
        if (!Array.isArray(games)) return;

        games.forEach(game => {
            if (!game) return;
            const title = String(game.title || "");
            const raw = stripBookmarkPrefixAndExtension(String(game.raw || game.file || ""));
            const separatedTitle = normalizeChunk(title);
            const separatedRaw = normalizeChunk(raw);

            if (/\s/.test(separatedTitle)) {
                separatedTitle.split(/\s+/).forEach(rememberWord);
            }
            if (/\s/.test(separatedRaw)) {
                separatedRaw.split(/\s+/).forEach(rememberWord);
            }
        });
    }

    function getRecognizedToken(raw) {
        if (!raw) return null;
        if (/^\d+$/.test(raw)) return raw;
        if (WORD_FREQUENCY.has(raw)) return raw;
        if (raw.endsWith("s") && WORD_FREQUENCY.has(raw.slice(0, -1))) return raw;

        const repeatedTailMatch = raw.match(/^(.*?)(.)\2+$/);
        if (repeatedTailMatch) {
            const stem = `${repeatedTailMatch[1]}${repeatedTailMatch[2]}`;
            if (WORD_FREQUENCY.has(stem)) return raw;
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

                const frequencyBonus = Math.min(WORD_FREQUENCY.get(part) || 1, 12) * 0.15;
                const score = rest.score + part.length * 8 - 1 + frequencyBonus;
                const candidate = { score, tokens: [part, ...rest.tokens] };
                if (!best || candidate.score > best.score) best = candidate;
            }

            memo.set(index, best);
            return best;
        }

        const result = solve(0);
        return result ? result.tokens : [lower];
    }

    function formatToken(token, index) {
        const lower = token.toLowerCase();
        if (/^\d+$/.test(lower)) return lower;
        if (index > 0 && MINOR_TITLE_WORDS.has(lower)) return lower;
        return lower.charAt(0).toUpperCase() + lower.slice(1);
    }

    function humanizeBookmarkDisplayName(name, stripExtension = true) {
        const raw = stripExtension
            ? stripBookmarkPrefixAndExtension(name)
            : String(name || "").replace(/\.html$/i, "");
        const normalized = normalizeChunk(raw);
        if (!normalized) return "";

        const tokens = normalized
            .split(/\s+/)
            .filter(Boolean)
            .flatMap(part => splitAlphaNumericChunk(part));

        return tokens.map(formatToken).join(" ").replace(/\s+/g, " ").trim();
    }

    function normalizeGameTitleForSearch(value) {
        return String(value == null ? "" : value)
            .normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "");
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
    window.normalizeGameTitleForSearch = normalizeGameTitleForSearch;
    window.configureGameTitleVocabulary = configureGameTitleVocabulary;
    window.buildBookmarkSourceKey = buildBookmarkSourceKey;
    window.buildBookmarkIdFromSourceKey = buildBookmarkIdFromSourceKey;
})();
