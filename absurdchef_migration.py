# ============================================================
# AbsurdChef Migration Script
# Run in Google Colab — paste entire file as one cell
# ============================================================

# ── CONFIGURATION ────────────────────────────────────────────
import os
from pathlib import Path

_here = Path(__file__).parent
_env = _here / ".env"
if _env.exists():
    for _line in _env.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())

SHEET_ID                 = os.environ["GOOGLE_SHEET_ID"]
ANTHROPIC_API_KEY        = os.environ["ANTHROPIC_API_KEY"]
SUPABASE_URL             = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
SERVICE_ACCOUNT_JSON_PATH = os.environ["GOOGLE_SERVICE_ACCOUNT_PATH"]
OUTPUT_DIR               = str(_here)
# ─────────────────────────────────────────────────────────────

import json, re, time
import gspread
from google.oauth2.service_account import Credentials
import anthropic
from supabase import create_client

print("✓ Dependencies installed")

# ── Auth ────────────────────────────────────────────────────
scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
creds = Credentials.from_service_account_file(SERVICE_ACCOUNT_JSON_PATH, scopes=scopes)
gc = gspread.authorize(creds)
sheet = gc.open_by_key(SHEET_ID)

claude = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

print("✓ Authenticated")

# ── Helper: read sheet tab as list of dicts ─────────────────
def read_tab(name):
    ws = sheet.worksheet(name)
    return ws.get_all_records()

# ── Load reference tabs ─────────────────────────────────────
cuisine_map = {r["ID"]: r["Cuisine"] for r in read_tab("Cuisine Type")}
meal_type_map = {r["ID"]: r["Meal Type"] for r in read_tab("Meal Type")}
cooking_type_map = {r["ID"]: r["Cooking Type"] for r in read_tab("Cooking Type")}
template_map = {r["ID"]: r["Category "].strip() for r in read_tab("Template Category ")}

# Last made dates
last_made_raw = read_tab("Meals Last Made")
last_made_map = {}
for r in last_made_raw:
    if r.get("Meal") and r.get("Date") and r["Date"] not in ("", "30/12/1899"):
        last_made_map[r["Meal"].strip().lower()] = r["Date"]

# Recipe instructions (Recipe List tab)
recipe_list_raw = read_tab("Recipe List")
instructions_map = {}
ingredients_map = {}
for r in recipe_list_raw:
    meal_name = r.get("Meal", "").strip()
    if not meal_name:
        continue
    instructions_map[meal_name.lower()] = r.get("Instructions", "").strip()
    raw_ingredients = r.get("Ingredient List", "").strip()
    if raw_ingredients:
        ingredients_map[meal_name.lower()] = raw_ingredients

# Frozen meals → freezer stash seed
frozen_meals_raw = read_tab("Frozen Meals")
frozen_seed = []
for r in frozen_meals_raw:
    qty = r.get("Quantity Left", 0)
    try:
        qty = int(qty)
    except:
        qty = 0
    if qty > 0:
        frozen_seed.append({
            "recipe_name": r.get("Meal", "").strip(),
            "portions": qty,
            "frozen_date": r.get("Date Prepped") or None,
            "notes": r.get("Notes", "") or None,
        })

print(f"✓ Loaded reference data — {len(frozen_seed)} active frozen meals")

# ── Cuisine normalisation ────────────────────────────────────
CUISINE_NORM = {
    "Generic": "generic",
    "Indian": "indian",
    "Asian": "asian",
    "EU/American": "eu_american",
    "Other Cuisines": "other",
}

MEAL_TYPE_NORM = {
    "Breakfast": "breakfast",
    "Lunch/Dinner": "lunch_dinner",
    "Dessert": "dessert",
    "Snack": "snack",
    "Special Occasion Dish": "special",
    "Meals Kids Love": "kids",
    "Meal Prep": "meal_prep",
}

COOKING_NORM = {
    "Slow Cook": "slow_cook",
    "Pressure Cook": "pressure_cook",
    "Stovetop": "stovetop",
    "Oven": "oven",
    "Microwave": "microwave",
    "No Cook": "no_cook",
}

TEMPLATE_NORM = {
    "White Meat": "white_meat",
    "Red Meat": "red_meat",
    "Mostly Carbs": "carbs",
    "Veg Protein": "veg_protein",
    "Vegetables & Egg": "veg_egg",
    "Usually Weekends": "weekends",
    "Meal Prep": "meal_prep",
    "Special Occasion": "special",
    "Unassigned": None,
}

def parse_time(val):
    if not val or str(val).strip() == "":
        return None
    s = str(val).strip().lower()
    if "h" in s:
        try:
            return int(float(s.replace("h", "").strip()) * 60)
        except:
            pass
    try:
        return int(float(s))
    except:
        return None

def infer_protein(name, instructions, cuisine_raw):
    name_l = name.lower()
    inst_l = (instructions or "").lower()
    for p in ["chicken", "beef", "lamb", "pork", "fish", "salmon", "goat", "turkey"]:
        if p in name_l or p in inst_l:
            return p
    if any(w in name_l for w in ["paneer", "dal", "lentil", "channa", "rajma", "bean",
                                   "cauliflower", "cabbage", "mushroom", "egg", "tofu",
                                   "aloo", "palak", "sambar"]):
        return "vegetarian"
    return None

def infer_style(name, instructions):
    name_l = name.lower()
    inst_l = (instructions or "").lower()
    style_hints = {
        "curry": ["curry", "masala", "tikka", "korma"],
        "stew": ["stew", "tagine", "braised"],
        "soup": ["soup", "sambar", "dal", "khichdi"],
        "pasta": ["pasta", "noodle", "tortellini", "gnocchi", "spaghetti", "mac"],
        "rice": ["rice", "biryani", "fried rice", "couscous"],
        "taco": ["taco", "quesadilla", "wrap", "burrito"],
        "burger": ["burger", "patty"],
        "pizza": ["pizza"],
        "pancake": ["pancake", "waffle", "dutch baby"],
        "porridge": ["porridge", "oatmeal", "cereal"],
        "salad": ["salad"],
        "roasted": ["roast", "bake", "sheet pan"],
        "meatball": ["meatball", "meatloaf"],
        "chapati": ["chapati"],
    }
    for style, keywords in style_hints.items():
        for kw in keywords:
            if kw in name_l or kw in inst_l:
                return style
    return "other"

# ── AI: generate ADHD-friendly instruction layers ───────────
ADHD_SYSTEM = """You are a meal prep assistant helping a busy parent with ADHD cook family meals.
Given a recipe name and its original instructions, extract and reformat into three categories:

1. night_before: array of short action strings (max 4 items). Things to do the evening before.
   Examples: "Soak chickpeas in cold water overnight", "Marinate chicken in yoghurt mix"
   Return [] if nothing needs doing the night before.

2. morning_of: array of short action strings (max 3 items). Things to do the morning of cooking day.
   Examples: "Move chicken from freezer to fridge to defrost", "Drain and rinse chickpeas"
   Return [] if nothing needed.

3. when_cooking: array of short action strings (max 6 items). The actual cook steps, stripped of
   all uncertainty and narrative. Each step is one clear action.
   Examples: "Add chicken and all marinade to Instant Pot, pressure cook 5 min",
   "Tip everything into slow cooker, set to Low 6h, walk away"

4. the_scary_bit: single string. The one step that looks intimidating but is actually easy.
   Examples: "The pressure cooker will hiss — that's normal, just leave it",
   "Browning the mince first is optional, skip it on a busy night"
   Return null if nothing is scary-looking.

Return ONLY valid JSON with keys: night_before, morning_of, when_cooking, the_scary_bit
No markdown, no explanation, no wrapper text."""

def get_adhd_layers(name, instructions, cooking_method):
    if not instructions or len(instructions.strip()) < 20:
        return {
            "night_before": [],
            "morning_of": [],
            "when_cooking": ["Follow original recipe instructions."],
            "the_scary_bit": None
        }

    prompt = f"""Recipe: {name}
Cooking method: {cooking_method or 'unknown'}

Original instructions:
{instructions[:3000]}"""

    try:
        response = claude.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=600,
            system=ADHD_SYSTEM,
            messages=[{"role": "user", "content": prompt}]
        )
        text = response.content[0].text.strip()
        text = re.sub(r"```json|```", "", text).strip()
        parsed = json.loads(text)
        return {
            "night_before": parsed.get("night_before", []),
            "morning_of": parsed.get("morning_of", []),
            "when_cooking": parsed.get("when_cooking", []),
            "the_scary_bit": parsed.get("the_scary_bit"),
        }
    except Exception as e:
        print(f"  ⚠ AI error for {name}: {e}")
        return {"night_before": [], "morning_of": [], "when_cooking": [], "the_scary_bit": None}

# ── Parse ingredient lines ───────────────────────────────────
UNITS = ["g", "kg", "ml", "l", "tsp", "tbsp", "cup", "cups", "oz", "lb", "lbs",
         "tablespoon", "tablespoons", "teaspoon", "teaspoons", "cloves", "clove",
         "can", "cans", "bag", "bags", "bunch", "handful", "slice", "slices",
         "piece", "pieces", "stick", "sticks", "sprig", "sprigs", "pinch"]

UNIT_NORM = {
    "tablespoon": "tbsp", "tablespoons": "tbsp",
    "teaspoon": "tsp", "teaspoons": "tsp",
    "cups": "cup", "lbs": "lb", "cans": "can", "bags": "bag",
    "cloves": "count", "clove": "count", "pieces": "count", "piece": "count",
    "slices": "count", "slice": "count",
}

PANTRY_KEYWORDS = ["oil", "salt", "pepper", "spice", "powder", "cumin", "turmeric",
                    "garam", "chili", "coriander", "oregano", "paprika", "cinnamon",
                    "sugar", "honey", "vinegar", "soy sauce", "flour", "cornstarch",
                    "broth", "stock", "tomato paste", "tomato puree", "bay leaf",
                    "dried", "seed", "seeds", "paste", "sauce", "extract", "vanilla"]
FREEZER_KEYWORDS = ["frozen", "freeze", "peas", "corn", "cauliflower florets"]
FRESH_KEYWORDS = ["onion", "garlic", "ginger", "tomato", "lemon", "lime", "carrot",
                   "potato", "spinach", "broccoli", "pepper", "celery", "parsley",
                   "cilantro", "basil", "herb", "berry", "fruit"]
FRIDGE_KEYWORDS = ["yoghurt", "yogurt", "cream", "milk", "cheese", "butter", "egg",
                    "paneer", "chicken", "beef", "mince", "lamb", "pork", "fish",
                    "salmon", "tofu", "ghee"]

def categorise_ingredient(name_lower):
    for kw in FREEZER_KEYWORDS:
        if kw in name_lower:
            return "freezer"
    for kw in PANTRY_KEYWORDS:
        if kw in name_lower:
            return "pantry"
    for kw in FRESH_KEYWORDS:
        if kw in name_lower:
            return "fresh_produce"
    for kw in FRIDGE_KEYWORDS:
        if kw in name_lower:
            return "fridge"
    return "pantry"

def parse_ingredient_line(line, order_index):
    line = line.strip().lstrip("•·-–*▢")
    if not line or len(line) < 2:
        return None

    # Try to extract quantity + unit + name
    # Pattern: number(s) [unit] name [, notes]
    pat = r'^([\d¼½¾⅓⅔\./\-\s]+)?\s*(' + '|'.join(UNITS) + r')s?\s+(.+)$'
    m = re.match(pat, line, re.IGNORECASE)

    qty = None
    unit = None
    name = line
    notes = None

    if m:
        qty_str = (m.group(1) or "").strip()
        unit_raw = m.group(2).strip().lower()
        name = m.group(3).strip()
        unit = UNIT_NORM.get(unit_raw, unit_raw)
        # Parse qty fractions
        frac_map = {"¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 0.33, "⅔": 0.67}
        for sym, val in frac_map.items():
            qty_str = qty_str.replace(sym, str(val))
        try:
            if "-" in qty_str:
                parts = qty_str.split("-")
                qty = (float(parts[0]) + float(parts[1])) / 2
            elif "/" in qty_str:
                parts = qty_str.split("/")
                qty = float(parts[0]) / float(parts[1])
            else:
                qty = float(qty_str) if qty_str else None
        except:
            qty = None

    # Split notes after comma
    if "," in name:
        parts = name.split(",", 1)
        name = parts[0].strip()
        notes = parts[1].strip()
    # Strip bracketed notes
    bracket_match = re.search(r'\((.+?)\)', name)
    if bracket_match:
        notes = (notes + " " + bracket_match.group(0)).strip() if notes else bracket_match.group(0)
        name = name.replace(bracket_match.group(0), "").strip()

    category = categorise_ingredient(name.lower())

    return {
        "name": name[:200],
        "quantity": qty,
        "unit": unit,
        "category": category,
        "notes": notes[:200] if notes else None,
        "order_index": order_index,
    }

def parse_ingredients(raw_text):
    if not raw_text:
        return []
    lines = raw_text.split("\n")
    result = []
    for i, line in enumerate(lines):
        parsed = parse_ingredient_line(line, i)
        if parsed:
            result.append(parsed)
    return result

# ── Main migration loop ──────────────────────────────────────
meal_list = read_tab("Meal List")
recipes_seed = []
ingredients_seed = []

print(f"\n→ Processing {len(meal_list)} recipes with AI...\n")

skipped_types = {"meal_prep"}  # skip pure meal prep components

for i, row in enumerate(meal_list):
    name = row.get("Dish", "").strip()
    if not name:
        continue

    meal_type_raw = meal_type_map.get(row.get("Meal Type", ""), "")
    meal_type_norm = MEAL_TYPE_NORM.get(meal_type_raw, "lunch_dinner")

    if meal_type_norm in skipped_types:
        print(f"  skip (meal_prep): {name}")
        continue

    cuisine_raw = cuisine_map.get(row.get("Cuisine", ""), "Generic")
    cooking_raw = cooking_type_map.get(row.get("Cooking Type", ""), "")
    template_raw = template_map.get(row.get("Template Category ", ""), "")

    instructions = instructions_map.get(name.lower(), "")
    raw_ingredients = ingredients_map.get(name.lower(), "")

    # Build tags
    tags = []
    tag_raw = row.get("Tag", "")
    bulk = str(row.get("Bulk Quantity", "")).lower()
    if bulk.startswith("yes"):
        tags.append("freezable")
        tags.append("batch_cook")
    if "no bake" in tag_raw.lower():
        tags.append("no_bake")
    if "travel" in tag_raw.lower():
        tags.append("travel_friendly")
    template_slot = TEMPLATE_NORM.get(template_raw)
    if template_slot == "kids":
        tags.append("kidproof")
    if cooking_raw in ("Slow Cook", "Pressure Cook"):
        tags.append("dump")

    cooking_norm = COOKING_NORM.get(cooking_raw, None)
    protein = infer_protein(name, instructions, cuisine_raw)
    style = infer_style(name, instructions)
    last_made_val = last_made_map.get(name.lower())

    # AI pass
    print(f"  [{i+1}/{len(meal_list)}] {name}...", end=" ", flush=True)
    adhd = get_adhd_layers(name, instructions, cooking_norm)
    print("✓")
    time.sleep(0.3)  # gentle rate limiting

    recipe = {
        "name": name,
        "cuisine": CUISINE_NORM.get(cuisine_raw, "generic"),
        "meal_type": meal_type_norm,
        "template_slot": template_slot,
        "protein": protein,
        "style": style,
        "cooking_method": cooking_norm,
        "prep_time_min": parse_time(row.get("Prep Time", "")),
        "cook_time_min": parse_time(row.get("Cook Time", "")),
        "serves_base": 4,
        "is_freezable": "freezable" in tags,
        "can_double": bulk.startswith("yes"),
        "source_type": "book" if row.get("Recipe Source Notes", "").lower().startswith("recipe book") else
                        "web" if row.get("Web Link To Recipe", "") else
                        "app" if row.get("Recipe Source Notes", "").lower().startswith("app") else "manual",
        "source_detail": row.get("Web Link To Recipe", "") or row.get("Recipe Source Notes", "") or None,
        "original_instructions": instructions or None,
        "night_before": adhd["night_before"],
        "morning_of": adhd["morning_of"],
        "when_cooking": adhd["when_cooking"],
        "the_scary_bit": adhd["the_scary_bit"],
        "tags": tags,
        "last_made": last_made_val if last_made_val else None,
        "active": True,
    }

    recipes_seed.append(recipe)

    # Parse ingredients
    ing_list = parse_ingredients(raw_ingredients)
    for ing in ing_list:
        ing["_recipe_name"] = name  # temp link, resolved after insert
        ingredients_seed.append(ing)

print(f"\n✓ Processed {len(recipes_seed)} recipes, {len(ingredients_seed)} ingredient lines")

# ── Save JSON files ──────────────────────────────────────────
with open(f"{OUTPUT_DIR}/recipes_seed.json", "w") as f:
    json.dump(recipes_seed, f, indent=2, default=str)

with open(f"{OUTPUT_DIR}/ingredients_seed.json", "w") as f:
    json.dump(ingredients_seed, f, indent=2, default=str)

with open(f"{OUTPUT_DIR}/freezer_seed.json", "w") as f:
    json.dump(frozen_seed, f, indent=2, default=str)

print(f"✓ JSON files saved to {OUTPUT_DIR}/")

# ── Upload to Supabase ───────────────────────────────────────
print("\n→ Uploading to Supabase...")

# Upload recipes and capture returned IDs
name_to_id = {}
BATCH = 10

for i in range(0, len(recipes_seed), BATCH):
    batch = recipes_seed[i:i+BATCH]
    # Fix last_made date format
    for r in batch:
        if r.get("last_made"):
            try:
                from datetime import datetime
                for fmt in ["%d/%m/%Y", "%Y-%m-%d", "%b %d", "%d %b"]:
                    try:
                        r["last_made"] = datetime.strptime(r["last_made"], fmt).strftime("%Y-%m-%d")
                        break
                    except:
                        pass
            except:
                r["last_made"] = None
        # Remove temp key if present
        r.pop("_recipe_name", None)

    result = supabase.table("recipes").insert(batch).execute()
    for record in result.data:
        name_to_id[record["name"]] = record["id"]
    print(f"  recipes {i+1}–{min(i+BATCH, len(recipes_seed))} uploaded")

print(f"✓ {len(name_to_id)} recipes in Supabase")

# Upload ingredients
ing_upload = []
for ing in ingredients_seed:
    recipe_name = ing.pop("_recipe_name", None)
    recipe_id = name_to_id.get(recipe_name)
    if recipe_id:
        ing["recipe_id"] = recipe_id
        ing_upload.append(ing)

for i in range(0, len(ing_upload), 50):
    batch = ing_upload[i:i+50]
    supabase.table("recipe_ingredients").insert(batch).execute()

print(f"✓ {len(ing_upload)} ingredients uploaded")

# Upload freezer stash
if frozen_seed:
    for item in frozen_seed:
        # Try to match recipe
        recipe_id = name_to_id.get(item["recipe_name"])
        item["recipe_id"] = recipe_id
        if item.get("frozen_date"):
            try:
                from datetime import datetime
                for fmt in ["%b %d", "%d/%m/%Y", "%Y-%m-%d"]:
                    try:
                        item["frozen_date"] = datetime.strptime(
                            item["frozen_date"] + " 2024" if "2024" not in item["frozen_date"] and "2025" not in item["frozen_date"] else item["frozen_date"],
                            fmt + (" %Y" if "2024" not in item["frozen_date"] else "")
                        ).strftime("%Y-%m-%d")
                        break
                    except:
                        pass
            except:
                item["frozen_date"] = None
    supabase.table("freezer_stash").insert(frozen_seed).execute()
    print(f"✓ {len(frozen_seed)} freezer stash items uploaded")

print("\n✅ Migration complete.")
print(f"   Recipes:     {len(name_to_id)}")
print(f"   Ingredients: {len(ing_upload)}")
print(f"   Freezer:     {len(frozen_seed)}")
print("\nNext: download recipes_seed.json and check a few ADHD layers look right.")
print("Then tell Claude you're ready to build the PWA screens.")
