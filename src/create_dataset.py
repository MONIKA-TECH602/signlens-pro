"""
create_dataset.py  —  Extract MediaPipe landmarks from ASL images → CSV

Usage:
    python src/create_dataset.py --data_dir /path/to/asl_alphabet_train

Output: dataset/data.csv
"""
import os, csv, argparse
import numpy as np, cv2
import mediapipe as mp
from tqdm import tqdm

parser = argparse.ArgumentParser()
parser.add_argument("--data_dir", required=True)
parser.add_argument("--output",   default="dataset/data.csv")
parser.add_argument("--max_per_class", type=int, default=500)
args = parser.parse_args()

mp_hands = mp.solutions.hands
hands    = mp_hands.Hands(static_image_mode=True, max_num_hands=1, min_detection_confidence=0.3)

os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
header = ["label"] + [f"{c}{i}" for i in range(21) for c in ("x","y")]

skipped = written = 0
with open(args.output, "w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(header)

    class_dirs = sorted(d for d in os.listdir(args.data_dir) if os.path.isdir(os.path.join(args.data_dir,d)))
    print(f"Found {len(class_dirs)} classes: {class_dirs}\n")

    for cls in class_dirs:
        cls_path = os.path.join(args.data_dir, cls)
        files    = [f for f in os.listdir(cls_path) if f.lower().endswith((".jpg",".jpeg",".png"))]
        if args.max_per_class > 0: files = files[:args.max_per_class]
        print(f"Class '{cls}' — {len(files)} images")

        for fname in tqdm(files, leave=False):
            img = cv2.imread(os.path.join(cls_path, fname))
            if img is None: skipped += 1; continue
            rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            res = hands.process(rgb)
            if not res.multi_hand_landmarks: skipped += 1; continue

            lm    = res.multi_hand_landmarks[0]
            raw_x = [p.x for p in lm.landmark]
            raw_y = [p.y for p in lm.landmark]
            min_x, min_y = min(raw_x), min(raw_y)
            ext = max(max(raw_x)-min_x, max(raw_y)-min_y) + 1e-6
            nx = [(x-min_x)/ext for x in raw_x]
            ny = [(y-min_y)/ext for y in raw_y]
            feats = [v for pair in zip(nx,ny) for v in pair]
            writer.writerow([cls] + [round(v,6) for v in feats])
            written += 1

hands.close()
print(f"\n✓ Written {written} rows to {args.output} | Skipped {skipped}")
print("Next: python src/train_model.py")
