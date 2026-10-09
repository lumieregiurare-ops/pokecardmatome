"""OGP 画像（1200x630）を作る。サイトと同じ書体（Noto Sans JP / Barlow Condensed / JetBrains Mono）を使う。

書体の TTF はリポジトリに置いていないので、置き場所を引数で渡す（Google Fonts からダウンロードしたもの）。
  python scripts/make-og.py <TTF を入れたフォルダ>
フォルダの中から NotoSansJP-Black.ttf / NotoSansJP_900Black.ttf のような名前のファイルを探す。
文字の詰め（palt）に libraqm を使う（Pillow を raqm 付きで入れておく）。
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "assets" / "og.png"

BG = (13, 14, 16)
PANEL = (20, 21, 24)
LINE = (37, 39, 44)
FG = (236, 235, 230)
FG2 = (168, 170, 176)
FG3 = (117, 120, 127)
ACCENT = (246, 201, 69)
HOT = (255, 90, 60)
OK = (79, 207, 148)
SOON = (127, 168, 255)


def find_font(folder, *names):
    for n in names:
        for p in Path(folder).rglob("*.ttf"):
            if p.stem.replace("-", "_").lower() == n.lower():
                return str(p)
    raise SystemExit(f"書体が見つかりません: {names}")


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    d = sys.argv[1]
    ja_black = find_font(d, "NotoSansJP_900Black", "NotoSansJP_Black")
    ja_med = find_font(d, "NotoSansJP_500Medium", "NotoSansJP_Medium")
    ja_bold = find_font(d, "NotoSansJP_700Bold", "NotoSansJP_Bold")
    disp = find_font(d, "BarlowCondensed_600SemiBold", "BarlowCondensed_SemiBold")
    disp_b = find_font(d, "BarlowCondensed_700Bold", "BarlowCondensed_Bold")
    mono = find_font(d, "JetBrainsMono_500Medium", "JetBrainsMono_Medium")

    # 2 倍で描いて縮める（文字と斜めの線をなめらかにする）
    S = 2
    img = Image.new("RGB", (W * S, H * S), BG)
    g = ImageDraw.Draw(img)

    def f(path, size):
        return ImageFont.truetype(path, size * S)

    def rect(x0, y0, x1, y1, fill=None, outline=None, width=1):
        g.rectangle([x0 * S, y0 * S, x1 * S, y1 * S], fill=fill, outline=outline, width=width * S)

    # かなを詰める（サイトの font-feature-settings: "palt" と同じ）
    def text(x, y, s, font, fill, anchor="la"):
        g.text((x * S, y * S), s, font=font, fill=fill, anchor=anchor, features=["palt"])

    # 上の黄色い線（サイトの上端と同じ）
    rect(0, 0, W, 6, fill=ACCENT)

    # 右側: 抽選ボードを思わせる行
    bx, by, bw = 690, 132, 450
    rect(bx, by, bx + bw, by + 372, fill=PANEL, outline=LINE)
    rect(bx - 1, by - 1, bx + 70, by + 3, fill=ACCENT)
    text(bx + 26, by + 24, "LOTTERY BOARD", f(disp, 20), ACCENT)
    rows = [(HOT, "10/12", "TODAY"), (OK, "10/14", "2 DAYS"), (OK, "10/17", "5 DAYS"), (SOON, "10/20", "SOON"), (FG3, "—", "INFO")]
    for i, (c, date, left) in enumerate(rows):
        y = by + 70 + i * 58
        g.line([(bx + 20) * S, (y - 8) * S, (bx + bw - 20) * S, (y - 8) * S], fill=LINE, width=S)
        rect(bx + 26, y + 12, bx + 38, y + 24, fill=c)
        text(bx + 56, y + 2, date, f(disp, 34), FG if c != FG3 else FG3)
        text(bx + 150, y + 10, left, f(mono, 14), FG3 if c != HOT else HOT)
        # 見出しの代わりの棒（文字は入れない）
        widths = [170, 140, 180, 120, 150]
        rect(bx + 240, y + 9, bx + 240 + widths[i], y + 15, fill=(58, 61, 68))
        rect(bx + 240, y + 23, bx + 240 + widths[i] - 60, y + 28, fill=(42, 44, 50))

    # 左側: ロゴの絵とサイト名
    mark = Image.new("RGBA", (160 * S, 200 * S), (0, 0, 0, 0))
    m = ImageDraw.Draw(mark)
    m.rounded_rectangle([20 * S, 20 * S, 110 * S, 150 * S], radius=10 * S, outline=FG3, width=4 * S)
    back = mark.rotate(9, resample=Image.BICUBIC, center=(65 * S, 85 * S))
    front = Image.new("RGBA", (160 * S, 200 * S), (0, 0, 0, 0))
    fr = ImageDraw.Draw(front)
    fr.rounded_rectangle([44 * S, 30 * S, 134 * S, 160 * S], radius=10 * S, fill=ACCENT)
    fr.rounded_rectangle([58 * S, 46 * S, 120 * S, 92 * S], radius=4 * S, fill=BG)
    front = front.rotate(-7, resample=Image.BICUBIC, center=(89 * S, 95 * S))
    img.paste(back, (64 * S, 96 * S), back)
    img.paste(front, (64 * S, 96 * S), front)

    title_font = f(ja_black, 118)
    x0, y0 = 72, 300
    text(x0, y0, "ポケカ", title_font, FG)
    w = g.textlength("ポケカ", font=title_font, features=["palt"]) / S
    text(x0 + w + 4, y0, "速報", title_font, ACCENT)

    text(x0 + 2, y0 + 150, "抽選・予約 / 新弾 / 再販 / 大会", f(ja_bold, 34), FG2)
    text(x0 + 2, y0 + 204, "ポケモンカードのニュースを 30 分おきに更新", f(ja_med, 22), FG3)

    text(x0, 588, "POKECARDMATOME.GAMELAB.WEBSITE", f(mono, 15), FG3)
    text(W - 60, 588, "TCG NEWS WIRE", f(disp_b, 18), FG3, anchor="ra")

    img = img.resize((W, H), Image.LANCZOS)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, optimize=True)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
