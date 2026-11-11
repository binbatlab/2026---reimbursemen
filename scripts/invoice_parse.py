# -*- coding: utf-8 -*-
"""发票解析 + 一致性校验：把 PDF 文本变成结构化数据，并在填单前先自证一遍。
用法: python _tools/invoice_parse.py
输入: invoices/raw/texts.json
输出: invoices/dataset.json, invoices/report.txt
退出码: 0 无错误, 1 有错误（可用于拦截填单）
"""
import json
import io
import os
import re
import sys
from decimal import Decimal as D

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BUYER_TAX_ID = "121000004352307294"   # 西安电子科技大学
BUYER_NAME = "西安电子科技大学"
TOL = D("0.01")

# 持票人姓名：发票正文里姓名出现在行程/航班号附近。默认不绑定具体姓名
# （匹配任意 2-6 个汉字），如需精确匹配可用环境变量 YWTB_HOLDER_NAME 指定。
_HOLDER = os.environ.get("YWTB_HOLDER_NAME", "").strip()
HOLDER_PAT = re.escape(_HOLDER) if _HOLDER else r"[\u4e00-\u9fa5]{2,6}"

def money(s):
    return D(str(s).replace(",", "").strip())

def parse_invoice(name, text):
    inv = {"file": name, "kind": None}
    lines = [l.strip() for l in text.splitlines()]
    inv["number"] = next((l for l in lines if re.fullmatch(r"\d{20}", l)), None)
    inv["date"] = next((l for l in lines if re.fullmatch(r"\d{4}年\d{1,2}月\d{1,2}日", l)), None)

    # 购销方识别：不同票面的行列顺序不一致，不能按位置硬取。
    # 先抓全部 18 位纳税识别号，学校税号优先认定为购买方；名称按是否含学校名判定。
    inv["buyer"] = inv["buyer_tax"] = inv["seller"] = inv["seller_tax"] = None
    ids = re.findall(r"(?<![0-9A-Z])[0-9A-Z]{18}(?![0-9A-Z])", text)
    if BUYER_TAX_ID in ids:
        inv["buyer_tax"] = BUYER_TAX_ID
        inv["seller_tax"] = next((x for x in ids if x != BUYER_TAX_ID), None)
    elif ids:
        inv["buyer_tax"] = ids[0]
        inv["seller_tax"] = ids[1] if len(ids) > 1 else None
    if BUYER_NAME in text:
        inv["buyer"] = BUYER_NAME
        orgs = [s.strip() for s in
                re.findall(r"[\u4e00-\u9fa5（）()·]{2,40}?(?:事务所（特殊普通合伙）|事务所|有限责任公司|有限公司|公司|中心|研究院|大学|医院)", text)
                if BUYER_NAME not in s]
        inv["seller"] = max(orgs, key=len) if orgs else None

    if "代收转付境内机票费" in text:
        inv["kind"] = "机票"
        m = re.search(r"1\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+不征税", text)
        if m:
            inv["amount_ex_tax"] = money(m.group(2))
            inv["tax"] = D("0.00")
        note = re.search(r"携程订单[:：]\s*([^\n]+)", text)
        if note:
            inv["note"] = note.group(1).strip()
            d = re.search(r"(\d{4})/(\d{1,2})/(\d{1,2})", note.group(1))
            inv["travel_date"] = f"{d.group(1)}-{int(d.group(2)):02d}-{int(d.group(3)):02d}" if d else None
            r = re.search(r"([\u4e00-\u9fa5]{2,6})[-—]([\u4e00-\u9fa5]{2,6})\s+([A-Z]{2}\d{3,4})", note.group(1))
            if r:
                inv["from"], inv["to"], inv["flight"] = r.group(1), r.group(2), r.group(3)
    elif re.search(r"交通运输服务|客运服务|网约车|出租客运", text):
        inv["kind"] = "网约车"
        m = re.search(r"\*交通运输服务\*[^\n]*?([\d.]+)\s+1\s+([\d.]+)\s+(\d+)%\s+([\d.]+)", text)
        if m:
            inv["unit_price"], inv["amount_ex_tax"] = money(m.group(1)), money(m.group(2))
            inv["tax_rate"], inv["tax"] = m.group(3) + "%", money(m.group(4))
        # 路线在发票正文里是 "起点--终点"；订单号固定 16 位，避免误吃 18 位税号
        r = re.search(r"(?<!\d)(\d{16})(?!\d)\s+([^\n]{2,40}?)--([^\n]{2,60}?)\s+" + HOLDER_PAT, text, re.S)
        if r:
            inv["order_no"] = r.group(1)
            inv["from"] = re.sub(r"\s+", " ", r.group(2)).strip()
            inv["to"] = re.sub(r"\s+", " ", r.group(3)).strip()
        f = re.search(HOLDER_PAT + r"\s+\d{3}\*{4}\d{4}\s+([A-Z]{2}\d{3,4})", text)
        if f:
            inv["flight_ref"] = f.group(1)
    else:
        # 通用票（专利费、版面费、测试费、材料费…）：不属于差旅，不参与行程配对
        inv["kind"] = "其他"
        m = (re.search(r"合计\s*¥?\s*([\d.]+)\s+¥?\s*([\d.]+)", text)
             or re.search(r"¥\s*([\d.]+)\s+¥\s*([\d.]+)", text))
        if m:
            inv["amount_ex_tax"], inv["tax"] = money(m.group(1)), money(m.group(2))
        items = re.findall(r"\*[^*\n]+\*[^\n]{0,30}", text)
        if items:
            inv["items"] = [re.sub(r"\s+", " ", i).strip() for i in items[:5]]

    if inv["kind"] == "机票" and inv.get("amount_ex_tax") is not None:
        # 机票是"不征税"代收转付款，价税合计 = 金额；票面最后一个 ¥ 可能是税额 0.00
        inv["total"] = inv["amount_ex_tax"]
    else:
        totals = re.findall(r"¥\s*(\d+(?:\.\d{1,2})?)", text)
        inv["total"] = money(totals[-1]) if totals else None
    return inv

def parse_itinerary(name, text):
    it = {"file": name, "trips": []}
    head = re.search(r"行程日期：(\S+?)至(\S+)", text)
    if head:
        it["range"] = [head.group(1), head.group(2)]
    total = re.search(r"合计([\d.]+)元", text)
    if total:
        it["stated_total"] = money(total.group(1))
    for line in text.splitlines():
        m = re.match(r"\s*(\d+)\s+(接机/站|送机/站|市内用车|其他)\s+(\S+)\s+"
                     r"(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(.+?)\s+([\d.]+)\s*$", line)
        if m:
            it["trips"].append({
                "seq": int(m.group(1)), "type": m.group(2), "city": m.group(3),
                "date": m.group(4), "time": m.group(5),
                "segment": m.group(6).strip(), "amount": money(m.group(7)),
            })
    return it

def main():
    texts = json.load(io.open("invoices/raw/texts.json", encoding="utf-8"))
    invoices, itineraries, attachments = [], [], []
    for name, text in texts.items():
        if not text.strip() or text.startswith("ERR"):
            continue
        if "行程单" in name or "TRIP TABLE" in text:
            itineraries.append(parse_itinerary(name, text))
            continue
        # 只有真正的发票才当发票：有 20 位票号或"价税合计"字样
        if not (re.search(r"(?<!\d)\d{20}(?!\d)", text) or "价税合计" in text):
            attachments.append(name)          # 通知书/身份信息/清单等，属于附件
            continue
        invoices.append(parse_invoice(name, text))

    errors, warns = [], []
    seen = set()
    for inv in invoices:
        tag = inv["file"]
        n = inv.get("number")
        if not n or len(n) != 20:
            errors.append(f"{tag}: 发票号码非法 {n}")
        elif n in seen:
            errors.append(f"{tag}: 发票号码重复 {n}")
        seen.add(n)
        if inv.get("buyer_tax"):
            if inv["buyer_tax"] != BUYER_TAX_ID:
                errors.append(f"{tag}: 购买方税号非本校 {inv['buyer_tax']}")
        elif inv.get("buyer") and BUYER_NAME not in inv["buyer"]:
            errors.append(f"{tag}: 购买方名称非本校 {inv['buyer']}")
        if inv["kind"] == "其他":
            warns.append(f"{tag}: 非差旅票据（按日常/无纸化报销处理），不做行程校验")
        if inv.get("total") is None:
            errors.append(f"{tag}: 未能解析价税合计")
        elif inv.get("amount_ex_tax") is not None and inv.get("tax") is not None:
            s = inv["amount_ex_tax"] + inv["tax"]
            if abs(s - inv["total"]) > TOL:
                errors.append(f"{tag}: 不含税+税额={s} ≠ 价税合计={inv['total']}")

    # 行程单 <-> 发票：按金额配对，把发票里的起终点回填进行程
    by_total = {}
    for inv in invoices:
        if inv.get("total") is not None:
            by_total.setdefault(inv["total"], []).append(inv)
    for it in itineraries:
        s = sum((t["amount"] for t in it["trips"]), D("0"))
        if it.get("stated_total") is not None and s != it["stated_total"]:
            errors.append(f"{it['file']}: 明细合计 {s} ≠ 行程单声明 {it['stated_total']}")
        if not it["trips"]:
            warns.append(f"{it['file']}: 未解析出明细行")
        for t in it["trips"]:
            cands = by_total.get(t["amount"], [])
            car = [c for c in cands if c["kind"] == "网约车"]
            if car:
                t["from"], t["to"] = car[0].get("from"), car[0].get("to")
                t["invoice_no"] = car[0]["number"]
            elif cands:
                t["invoice_no"] = cands[0]["number"]
            else:
                warns.append(f"{it['file']}: {t['segment']} 金额 {t['amount']} 无对应发票")

    air = [i for i in invoices if i["kind"] == "机票"]
    car = [i for i in invoices if i["kind"] == "网约车"]
    other = [i for i in invoices if i["kind"] == "其他"]
    total_air = sum((i["total"] for i in air if i.get("total")), D("0"))
    total_car = sum((i["total"] for i in car if i.get("total")), D("0"))
    total_other = sum((i["total"] for i in other if i.get("total")), D("0"))
    grand_total = total_air + total_car + total_other

    seq = sorted(
        [(t["date"], t["time"], t["city"], t.get("from") or t["segment"], t.get("to") or "", t["amount"], t["type"])
         for it in itineraries for t in it["trips"]]
    )

    L = []
    L.append("=" * 66)
    L.append("一、发票清单")
    L.append("=" * 66)
    for inv in sorted(invoices, key=lambda i: (i["kind"], str(i.get("date")))):
        L.append(f"[{inv['kind']}] ¥{inv['total']}  税{inv.get('tax')}  {inv.get('date')}")
        L.append(f"    票号 {inv.get('number')}   销售方 {inv.get('seller')}")
        if inv.get("flight"):
            L.append(f"    {inv['travel_date']} {inv['from']}->{inv['to']} {inv['flight']}")
        if inv.get("from") and not inv.get("flight"):
            L.append(f"    {inv['from']} -> {inv['to']}" + (f"  ({inv['flight_ref']})" if inv.get("flight_ref") else ""))
    L.append("")
    parts = [f"机票 ¥{total_air}", f"网约车 ¥{total_car}"]
    if total_other:
        parts.append(f"其他(日常) ¥{total_other}")
    L.append(" + ".join(parts) + f" = 合计 ¥{grand_total}")
    L.append("")
    L.append("=" * 66)
    L.append("二、行程顺序（差旅单明细按此填）")
    L.append("=" * 66)
    for d, t, city, f, to, amt, typ in seq:
        L.append(f"{d} {t}  {city:<3} {typ:<5} {f} -> {to}   ¥{amt}")
    L.append("")
    if attachments:
        L.append("=" * 66)
        L.append("三、非发票文件（应走审批单附件上传，不参与报销金额）")
        L.append("=" * 66)
        for a in attachments:
            L.append("   - " + a)
        L.append("")
    L.append("=" * 66)
    L.append("四、校验结果" if attachments else "三、校验结果")
    L.append("=" * 66)
    L.append(f"❌ 错误 {len(errors)} 条" if errors else "✅ 错误 0 条")
    for e in errors:
        L.append("   - " + e)
    if warns:
        L.append(f"⚠️  提示 {len(warns)} 条")
        for w in warns:
            L.append("   - " + w)
    report = "\n".join(L)

    os.makedirs("invoices", exist_ok=True)
    with io.open("invoices/report.txt", "w", encoding="utf-8") as fh:
        fh.write(report)

    def enc(o):
        return {k: (str(v) if isinstance(v, D) else v) for k, v in o.items()}
    payload = {
        "invoices": [enc(i) for i in invoices],
        "itineraries": [{"file": it["file"], "range": it.get("range"),
                         "stated_total": str(it.get("stated_total")) if it.get("stated_total") is not None else None,
                         "trips": [enc(t) for t in it["trips"]]} for it in itineraries],
        "summary": {"air_total": str(total_air), "car_total": str(total_car),
                    "other_total": str(total_other), "grand_total": str(grand_total)},
        "attachments": attachments, "errors": errors, "warnings": warns,
    }
    with io.open("invoices/dataset.json", "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
    print(report)
    return 1 if errors else 0

if __name__ == "__main__":
    sys.exit(main())
