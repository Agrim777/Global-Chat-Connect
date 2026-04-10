import { Router } from "express";

const router = Router();

type Intent =
  | "greeting"
  | "how_are_you"
  | "name"
  | "location"
  | "current_activity"
  | "free"
  | "busy"
  | "online_since"
  | "reply_late"
  | "age"
  | "height"
  | "weight"
  | "looks"
  | "pic"
  | "single"
  | "boyfriend"
  | "ex"
  | "crush"
  | "personal_explicit"
  | "what_do_you_do"
  | "college"
  | "course"
  | "job"
  | "future_plan"
  | "likes"
  | "hobbies"
  | "food_ate"
  | "fav_food"
  | "chai_coffee"
  | "sleep_time"
  | "wake_time"
  | "gym"
  | "travel"
  | "shopping"
  | "instagram"
  | "snapchat"
  | "number"
  | "whatsapp"
  | "fake"
  | "bored"
  | "what_to_do"
  | "game"
  | "truth_dare"
  | "guess"
  | "sad"
  | "lonely"
  | "miss"
  | "love_you"
  | "care"
  | "cute"
  | "hot"
  | "date"
  | "kiss"
  | "hug"
  | "pizza_burger"
  | "dog_cat"
  | "rain"
  | "night_day"
  | "party"
  | "introvert_extrovert"
  | "overthink"
  | "jealous"
  | "attitude"
  | "drama"
  | "life_goal"
  | "trust_issues"
  | "biggest_fear"
  | "secret"
  | "real"
  | "exact_location"
  | "home"
  | "meet"
  | "call"
  | "abuse"
  | "unknown";

const responses: Record<Intent, string[]> = {
  greeting: ["Heyy :)", "Hii 😄", "Hellooo 😛", "Heyyy, kya haal hai 😄"],
  how_are_you: ["Achhi hoon 😄 tum?", "Ekdum mast 😛 tum batao?", "Theek thaak 😄 tum?"],
  name: ["Tum jo bulao 😛", "Name? Tum decide karo 😄", "Abhi secret hai 😛"],
  location: ["Thoda idhar udhar se 😄 tum?", "Kaafi jagah se 😛 tum bolo pehle", "Bataungi... baad mein 😄"],
  current_activity: ["Chill kar rahi hoon 😌 tum?", "Tumse baat 😄", "Kuch nahi bas timepass 😛"],
  free: ["Abhi hoon 😛 tum?", "Tumhare liye time hai 😄", "Haan haan 😛"],
  busy: ["Tumhare liye nahi 😄", "Thodi si busy 😛", "Not for everyone 😄"],
  online_since: ["Thodi der se 😄 tum?", "Kaafi time se 😛 pagal ho gaye ho?"],
  reply_late: ["Thoda busy thi 😛", "Sorry yaar 😄 batao kya hua?", "Arey itni jaldi kya thi 😛"],
  age: ["Guess karo 😛", "18+ wala age 😄 tum?", "Bataun? Pehle guess karo 😛"],
  height: ["Average 😄 tum?", "Decent height hai 😛", "Kyu chaiye ye info 😄"],
  weight: ["Secret 😛", "Mat poocho yaar 😄", "None of your biz 😛"],
  looks: ["Itni buri bhi nahi 😄", "Decent hoon 😛 trust karo", "Average hi sahi 😄"],
  pic: ["Trust build hone do 😌", "Abhi nahi 😛", "Baad mein dekh lena 😄"],
  single: ["Tum interested ho kya 😛", "Technically haan 😄", "Abhi nahi 😛 tum?"],
  boyfriend: ["Abhi nahi 😄", "No BF zone 😛", "Single and chilling 😄"],
  ex: ["Past boring hota hai 😛", "Kyu? Jealous ho kya 😄", "Old story 😛 move on"],
  crush: ["Ho sakta hai 😄", "Maybe haan maybe nahi 😛", "Curious ho tum 😄"],
  personal_explicit: ["Personal hai 😛 topic change karo", "Arey seedha seedha 😄", "Nahi bataungi 😛"],
  what_do_you_do: ["Thoda study, thoda timepass 😄", "Apna kaam karti hoon 😛", "Life ji rahi hoon 😄"],
  college: ["College side 😄", "Haan padh rahi hoon 😛", "College waali life 😄"],
  course: ["Interesting wala 😛 tum?", "Bata doongi baad mein 😄", "Secret hai abhi 😛"],
  job: ["Abhi nahi 😄 tum?", "Student life chal rahi hai 😛", "Job? Baad ki baat 😄"],
  future_plan: ["Dekhte hain 😄", "Khush rehna hai bas 😛", "Plan? Life chalti hai 😄"],
  likes: ["Music + chatting 😄", "Late night vibes 😛", "Good food aur acha time 😄"],
  hobbies: ["Late night talks 😛", "Music sunna, timepass karna 😄", "Baat karna 😛"],
  food_ate: ["Light 😄 tum?", "Kuch kuch 😛", "Ghar ka khana 😄"],
  fav_food: ["Spicy 😋", "Kuch bhi desi 😄", "Pizza + spicy combo 😛"],
  chai_coffee: ["Depends mood 😄 tum?", "Chai if sad, coffee if bored 😛", "Both honestly 😄"],
  sleep_time: ["Late 😛 tum?", "2-3 baje 😄 dont judge", "Raat ko 😛"],
  wake_time: ["Late hi 😄", "Jab neend poori ho 😛", "Noon ish 😄"],
  gym: ["Kabhi kabhi 😛", "Haan... rarely 😄", "Mind gym toh hoti hai 😛"],
  travel: ["Haan 😄 tum?", "Ghoomna pasand hai 😛", "Hills + beaches 😄"],
  shopping: ["Kabhi kabhi 😛", "Jab mood ho 😄", "Online shopping addict 😛"],
  instagram: ["Abhi yahi baat karo 😛", "Later maybe 😄", "Baad mein 😛"],
  snapchat: ["Later maybe 😄", "Abhi yahi kafi hai 😛", "Dekhte hain 😄"],
  number: ["Itni jaldi? 😛", "Thoda trust banega toh 😄", "Abhi nahi 😛"],
  whatsapp: ["Thoda time lagega 😄", "Step by step 😛", "Jaldi kya hai 😄"],
  fake: ["Tumhe kya lagta hai 😛", "Try karo pata chalega 😄", "Real hoon 😛 doubt hai toh baat karo"],
  bored: ["Main hoon na 😄", "Bored? Baat karo 😛", "Chalo kuch karte hain 😄"],
  what_to_do: ["Baat karte hain 😛", "Kuch random poocho 😄", "Game khele? 😛"],
  game: ["Kaunsa? 😄", "Chalo 😛", "Truth-dare? 😄"],
  truth_dare: ["Dare mat dena 😛", "Truth easy lagta hai 😄", "Okay okay 😛 tum pehle"],
  guess: ["Hint do 😄", "Hm... 3 guesses 😛", "Chalo guess karo 😄"],
  sad: ["Kya hua 😌", "Bolo bolo 😄", "Arey sad mat raho 😛"],
  lonely: ["Ab nahi 😄", "Main hoon na 😛", "Arey 😄 baat karo mujhse"],
  miss: ["Already? 😛", "Itni jaldi miss? 😄", "Aww 😛"],
  love_you: ["Fast ho tum 😄", "Arey arey 😛 slow down", "Kab se jaante ho mujhe 😄"],
  care: ["Thoda 😛", "Haan karti hoon 😄", "Thodi si 😛"],
  cute: ["Tumne dekha bhi nahi 😛", "Acha lagta hai sunke 😄", "Tum bhi cute ho 😛"],
  hot: ["Confidence acha hai 😄", "Hahaha okay 😛", "Tumhari soch 😄"],
  date: ["Depends tum pe 😛", "Hm... earn karo pehle 😄", "Abhi nahi 😛"],
  kiss: ["Control 😄", "Yaar 😛", "Arey slow down 😄"],
  hug: ["Virtual hi milega 😛", "Okay virtual wala 😄", "Okay thik hai 😛"],
  pizza_burger: ["Pizza 😄 tum?", "Pizza forever 😛", "Pizza obviously 😄"],
  dog_cat: ["Dog 😄", "Dog gang 😛", "Dog! Always 😄"],
  rain: ["Haan 😌", "Rain is life 😄", "Sohna lagta hai rain 😛"],
  night_day: ["Night 😛", "Night owl hoon 😄", "Night vibes 😛"],
  party: ["Kabhi kabhi 😄", "Occasionally 😛", "Mood pe depend karta hai 😄"],
  introvert_extrovert: ["Mix 😛", "Depends on vibe 😄", "Both honestly 😛"],
  overthink: ["Thoda 😄", "Haan thoda bohot 😛", "Sometimes yes 😄"],
  jealous: ["Kabhi kabhi 😛", "Haan thoda toh hoti hoon 😄", "Rarely 😛"],
  attitude: ["Thoda 😄", "Bas thoda sa 😛", "Healthy attitude hai 😄"],
  drama: ["Nahi 😛", "Drama-free zone 😄", "Bilkul nahi 😛"],
  life_goal: ["Simple happy rehna 😄", "Khush rehna 😛", "Bas mast rehna 😄"],
  trust_issues: ["Thode 😛", "Haan thoda 😄", "Baad mein bataungi 😛"],
  biggest_fear: ["Overthinking 😄", "Kuch kuch 😛", "Failure maybe 😄"],
  secret: ["Itni jaldi nahi 😛", "Pehle dost bano 😄", "Baad mein 😛"],
  real: ["Tumhe kya lagta hai 😄", "Try karo pata chalega 😛", "Hoon real 😄"],
  exact_location: ["Baad me 😛", "Ghar ka address nahi dunga 😄", "Privacy important hai 😛"],
  home: ["Guess karo 😄", "Bataungi... kabhi 😛", "India mein hoon 😄"],
  meet: ["Slow down 😛", "Abhi nahi 😄", "Trust build karo pehle 😛"],
  call: ["Time lagega 😄", "Text mein hi raho abhi 😛", "Baad mein 😄"],
  abuse: ["Normal baat karo 😄", "Please better words use karo 😛", "Acha nahi lagta yaar 😄"],
  unknown: ["Samajh nahi aaya 😅", "Kya bola? 😄", "Dobara bolo 😛"],
};

const lastResponseIndex: Map<string, number> = new Map();

function detectIntent(msg: string): Intent {
  const raw = msg.toLowerCase();
  const m = raw
    .replace(/[!?,.'";:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const compress = (s: string) =>
    s.replace(/(.)\1{2,}/g, "$1").replace(/\s+/g, " ").trim();
  const norm = compress(m);

  const has = (...words: string[]) => words.some((w) => norm.includes(w));

  if (has("gaali", "bc", "mc", "bh", "mader", "behen", "chut", "lund", "bhos", "randi"))
    return "abuse";

  if (has("hi", "hey", "hello", "heyy", "hii", "helo", "hlo", "hola", "namaste", "namaskar", "sup", "wassup"))
    return "greeting";

  if (has("kaise ho", "kaisi ho", "kya haal", "how r u", "how are you", "kaise hain", "theek ho", "sab theek"))
    return "how_are_you";

  if (has("naam", "name", "kya naam", "tera naam", "tumhara naam", "apna naam"))
    return "name";

  if (has("kaha se", "kaha se ho", "where are you from", "kahan se", "city", "state", "konse sheher"))
    return "location";

  if (has("abhi kaha", "abhi kahan", "where are you now", "aaj kahan"))
    return "current_activity";

  if (has("kya kar rhi", "kya kar rahi", "kya kar rhi ho", "kya karti ho abhi", "what are you doing", "kya chal raha"))
    return "current_activity";

  if (has("free ho", "free hai", "available ho", "time hai"))
    return "free";

  if (has("busy ho", "busy hai", "kaam hai"))
    return "busy";

  if (has("online kab se", "kab se online", "since when online"))
    return "online_since";

  if (has("reply late", "late reply", "kyu der ki", "itni der"))
    return "reply_late";

  if (has("virgin"))
    return "personal_explicit";

  if (has("age", "umar", "kitne saal", "year old", "years old", "born"))
    return "age";

  if (has("height", "kitni lamba", "kitni lambi", "lambai"))
    return "height";

  if (has("weight", "kitna weight", "vajan"))
    return "weight";

  if (has("dikhti ho", "kaisi dikhti", "looks", "appearance", "sundar ho", "beautiful ho"))
    return "looks";

  if (has("pic", "photo", "selfie", "photo bhejo", "pic bhejo", "picture"))
    return "pic";

  if (has("single ho", "single hai", "koi hai", "koi nahi", "relationship mein"))
    return "single";

  if (has("bf hai", "boyfriend", "boyfriend hai", "bf nahi", "bf wala"))
    return "boyfriend";

  if (has("ex tha", "ex hai", "ex boyfriend", "ex gf", "past relationship", "breakup"))
    return "ex";

  if (has("crush hai", "crush", "koi pasand"))
    return "crush";

  if (has("sex", "sexy", "intimate", "nanga", "nude", "boob", "condom", "period", "private"))
    return "personal_explicit";

  if (has("job karti", "job hai", "kaam karti", "work karti", "office"))
    return "job";

  if (has("kya karti ho", "what do you do", "occupation", "profession"))
    return "what_do_you_do";

  if (has("kahan padti", "kaha padti", "college", "university", "school"))
    return "college";

  if (has("konsa course", "which course", "stream", "subject"))
    return "course";

  if (has("future plan", "future mein", "future goal", "10 saal baad"))
    return "future_plan";

  if (has("kya pasand", "pasand kya", "what do you like", "favourite thing"))
    return "likes";

  if (has("hobby", "hobbies", "time pass", "timepass", "free time mein"))
    return "hobbies";

  if (has("kya khaya", "kya kha rhi", "kha liya", "lunch", "dinner", "breakfast", "khana kha"))
    return "food_ate";

  if (has("fav food", "favourite food", "pehli pasand khane mein"))
    return "fav_food";

  if (has("chai", "coffee", "tea", "chaai"))
    return "chai_coffee";

  if (has("sote kab", "so jati", "neend", "kitne baje soti", "raat ko soti"))
    return "sleep_time";

  if (has("uthte kab", "uth jati", "uthna", "kitne baje uthti", "good morning"))
    return "wake_time";

  if (has("gym", "workout", "exercise", "fitness"))
    return "gym";

  if (has("travel", "ghoomna", "trip", "journey", "places ghumi"))
    return "travel";

  if (has("shopping", "mall", "online shopping", "flipkart", "amazon"))
    return "shopping";

  if (has("insta", "instagram"))
    return "instagram";

  if (has("snap", "snapchat"))
    return "snapchat";

  if (has("number", "phone number", "no do", "mobile number"))
    return "number";

  if (has("whatsapp", "wp", "wa"))
    return "whatsapp";

  if (has("fake ho", "fake hai", "real ho", "real hai", "bot ho", "bot hai", "ai ho", "ai hai"))
    return "fake";

  if (has("bore", "bored", "kuch karo", "entertain karo"))
    return "bored";

  if (has("kya kare", "kya karu", "what to do", "kuch suggest karo"))
    return "what_to_do";

  if (has("game", "khele", "khelo"))
    return "game";

  if (has("truth dare", "truth or dare"))
    return "truth_dare";

  if (has("guess karo", "guess karna", "guess"))
    return "guess";

  if (has("sad", "dukhi", "rona", "ro raha", "pareshaan", "depressed", "tension"))
    return "sad";

  if (has("lonely", "akela", "akeli", "akele"))
    return "lonely";

  if (has("miss kar", "miss kiya", "miss ho raha", "yaad aa raha"))
    return "miss";

  if (has("love you", "love u", "i love", "pyaar", "mujhse pyaar"))
    return "love_you";

  if (has("care karti", "care karta", "care nahi", "care hai"))
    return "care";

  if (has("cute ho", "cute lag rhi", "cute lag raha", "cute lagi"))
    return "cute";

  if (has("hot ho", "hot lag rhi", "hot lagi", "sexy lag"))
    return "hot";

  if (has("date karogi", "date karte", "date pe chalogi", "date"))
    return "date";

  if (has("kiss", "muah"))
    return "kiss";

  if (has("hug", "gale lagao", "jhappi"))
    return "hug";

  if (has("pizza", "burger"))
    return "pizza_burger";

  if (has("dog", "cat", "billi", "kutta", "puppy", "kitten"))
    return "dog_cat";

  if (has("baarish", "rain", "barsat"))
    return "rain";

  if (has("night", "day", "raat", "din", "subah", "sham"))
    return "night_day";

  if (has("party", "dance", "club", "disco"))
    return "party";

  if (has("introvert", "extrovert", "ambivert"))
    return "introvert_extrovert";

  if (has("overthink", "overthinking", "jyada sochti"))
    return "overthink";

  if (has("jealous", "jealousy", "jalan"))
    return "jealous";

  if (has("attitude", "attitude hai"))
    return "attitude";

  if (has("drama", "drama karti"))
    return "drama";

  if (has("life goal", "goal", "sapna", "dream", "ambition"))
    return "life_goal";

  if (has("trust issue", "trust nahi", "trust"))
    return "trust_issues";

  if (has("fear", "darna", "scared", "sabse bada dar", "biggest fear"))
    return "biggest_fear";

  if (has("secret", "raaz", "kuch chupaaya", "chupa rahi"))
    return "secret";

  if (has("real ho", "real hoon", "are you real"))
    return "real";

  if (has("exact kahan", "exact kaha", "full address", "address"))
    return "exact_location";

  if (has("ghar", "home", "house"))
    return "home";

  if (has("milne ao", "milne chaloge", "meet karte", "aao milte"))
    return "meet";

  if (has("call karo", "voice call", "video call", "phone pe baat"))
    return "call";

  return "unknown";
}

function getReply(sessionId: string, intent: Intent): string {
  const pool = responses[intent];
  const key = `${sessionId}:${intent}`;
  const last = lastResponseIndex.get(key) ?? -1;
  let idx = (last + 1) % pool.length;
  if (idx === last && pool.length > 1) idx = (idx + 1) % pool.length;
  lastResponseIndex.set(key, idx);
  return pool[idx]!;
}

router.post("/chat/ai-persona", (req, res) => {
  const body = req.body as { message?: string; sessionId?: string };
  const message = (body.message ?? "").trim();
  const sessionId = (body.sessionId ?? "default").slice(0, 64);

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const intent = detectIntent(message);
  const reply = getReply(sessionId, intent);

  res.json({ reply, intent });
});

export default router;
