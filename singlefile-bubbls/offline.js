// LAST GAME IS caseoh baldi
let files = [
  "1.5",
"1.8",
"8ballclassic",
"amongus",
"angrybirds",
"awesometanks2",
"baconmaydie",
"badicecream",
"badicecream2",
"badpiggies",
"basketballstars",
"basketbros",
"basketrandom",
"blockysnakes",
"blumgiracers",
"blumgirocket",
"bobtherobber",
"breakingthebank",
"bubbleshooter",
"candycrush",
"capybaraclicker",
"carkingarena",
"chess",
"choppyorc",
"circloO",
"circloO2",
"clashofvikings",
"crazycars",
"dadish2",
"dadish3",
"ducklife",
"ducklife4",
"eagleride",
"earntodie2",
"eggycar",
"escapingtheprison",
"evilglitch",
"fancypantsadventure",
"fireboyandwatergirl2",
"fireboyandwatergirl3",
"footballlegends",
"freerider3",
"fruitninja",
"geometrydash",
"googlebaseball",
"hanger2",
"hillclimbracinglite",
"houseofhazards",
"idlebreakout",
"Indev",
"johnnytrigger",
"jumpingshell",
"karatebros",
"learntofly",
"learntofly2",
"mergeroundracers",
"minesweeper",
"motox3m",
"motox3m2",
"motox3mpoolparty",
"motox3mspookyland",
"motox3mwinter",
"noobminer",
"ovo",
"ovo2",
"pacman",
"papasburgeria",
"papascupcakeria",
"papasfreezeria",
"papaspancakeria",
"papaswingeria",
"parkingfury",
"polytrack",
"ragdollarchers",
"ragdollhit",
"retrobowl",
"retrobowlcollege",
"retrohighway",
"retropingpong",
"riddleschool",
"riddleschool3",
"riddleschool4",
"rooftopsnipers2",
"sandgame",
"spacebarclicker",
"spaceiskey",
"spaceiskey2",
"spacewaves",
"speedstars",
"sprunki",
"stack",
"stickarchersbattle",
"stickfighter",
"stickmerge",
"superliquidsoccer",
"tabletennisworldtour",
"territorialio",
"theimpossiblequiz2",
"thisistheonlylevel",
"timeshooter2",
"vexx3m2",
"volleyrandom",
"webecomewhatwebehold",
"wheeliebike",
"wheely",
"wheely2",
"worldshardestgame2",
"wrestlebros",
"zombierush",
];
function generateAllSections() {
  try {
    document.getElementById("lolbutton").remove();
  } catch (e) {}
  const allChars = [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "A",
    "B",
    "C",
    "D",
    "E",
    "F",
    "G",
    "H",
    "I",
    "J",
    "K",
    "L",
    "M",
    "N",
    "O",
    "P",
    "Q",
    "R",
    "S",
    "T",
    "U",
    "V",
    "W",
    "X",
    "Y",
   "Z",
  ];

  const filesByChar = {};
  allChars.forEach((char) => {
    filesByChar[char] = [];
  });

  files.forEach((file) => {
    const firstChar = file[0].toUpperCase();
    if (filesByChar[firstChar]) {
      filesByChar[firstChar].push(file);
    }
  });

  const container = document.getElementById("sections-container");
  allChars.forEach((char) => {
    const section = document.createElement("div");
    section.className = "letter-section";
    section.id = `section-${char}`;

    const header = document.createElement("div");
    header.className = "letter-header";
    header.textContent = char;
    section.appendChild(header);

    const buttonsContainer = document.createElement("div");
    buttonsContainer.className = "buttons-container";

    if (filesByChar[char].length > 0) {
      filesByChar[char].forEach((file) => {
        const btn = document.createElement("input");
        btn.type = "button";
        btn.value = file;
        btn.onclick = () => {
          function normalizeFileName(name) {
            if (name.includes(".") && name.lastIndexOf(".") > 0) return name;
            return name + ".html";
          }

          const normalized = normalizeFileName(file);
          const encoded = encodeURIComponent(normalized);
          const url = `https://cdn.jsdelivr.net/gh/bubbls/ugs-singlefile@main/offline/${encoded}`;

          fetch(url)
            .then((text) => {
  const blob = new Blob([text], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
});
        };
        btn.style.width = "100%";
        btn.style.height = "100%";
        buttonsContainer.appendChild(btn);
      });
    } else {
      section.classList.add("empty");
      const emptyMsg = document.createElement("div");
      emptyMsg.className = "empty-message";
      emptyMsg.textContent = "No files";
      buttonsContainer.appendChild(emptyMsg);
    }

    section.appendChild(buttonsContainer);
    container.appendChild(section);
  });

  generateSidebar(allChars, filesByChar);
}

function generateSidebar(allChars, filesByChar) {
  const sidebar = document.getElementById("sidebar");

  allChars.forEach((char) => {
    const btn = document.createElement("button");
    btn.className = "sidebar-btn";
    btn.textContent = char;

    if (filesByChar[char].length === 0) {
      btn.classList.add("empty");
    } else {
      btn.onclick = () => {
        const section = document.getElementById(`section-${char}`);
        if (section) {
          section.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        }
      };
    }

    sidebar.appendChild(btn);
  });
}
generateAllSections();