#!/usr/bin/env python3
"""Compile a gettext .po file into a .mo file (no GNU gettext needed).

    python utils/compile-mo.py locales/nl_NL/LC_MESSAGES/messages.po

Supports msgctxt, plural forms and multi-line strings; fuzzy entries are skipped.
"""
import ast
import struct
import sys


def unquote(s):
    return ast.literal_eval(s)


def parse(path):
    entries = {}
    cur = {}
    field = None
    fuzzy = False

    def flush():
        nonlocal cur, fuzzy
        if 'msgid' in cur and not fuzzy:
            key = cur['msgid']
            if cur.get('msgctxt') is not None:
                key = cur['msgctxt'] + '\x04' + key
            if 'msgid_plural' in cur:
                key = key + '\x00' + cur['msgid_plural']
                val = '\x00'.join(cur['plural'][i] for i in sorted(cur['plural']))
            else:
                val = cur.get('msgstr', '')
            if val or key == '':
                entries[key] = val
        cur = {}
        fuzzy = False

    for raw in open(path, encoding='utf-8'):
        line = raw.strip()
        if not line:
            flush()
            field = None
            continue
        if line.startswith('#'):
            if line.startswith('#,') and 'fuzzy' in line:
                fuzzy = True
            continue
        if line.startswith('msgctxt '):
            if 'msgid' in cur:
                flush()
            cur['msgctxt'] = unquote(line[8:])
            field = 'msgctxt'
        elif line.startswith('msgid_plural '):
            cur['msgid_plural'] = unquote(line[13:])
            cur.setdefault('plural', {})
            field = 'msgid_plural'
        elif line.startswith('msgid '):
            if 'msgid' in cur:
                flush()
            cur['msgid'] = unquote(line[6:])
            field = 'msgid'
        elif line.startswith('msgstr['):
            idx = int(line[7:line.index(']')])
            cur.setdefault('plural', {})[idx] = unquote(line[line.index(']') + 2:])
            field = ('plural', idx)
        elif line.startswith('msgstr '):
            cur['msgstr'] = unquote(line[7:])
            field = 'msgstr'
        elif line.startswith('"'):
            text = unquote(line)
            if field is None and '' in entries:
                # Some files (like Spotweb's) put the header strings after a blank line
                entries[''] += text
            elif isinstance(field, tuple):
                cur['plural'][field[1]] += text
            elif field:
                cur[field] += text
    flush()
    return entries


def write_mo(entries, path):
    keys = sorted(entries.keys())
    ids = b''
    strs = b''
    offsets = []
    for k in keys:
        kb = k.encode('utf-8')
        vb = entries[k].encode('utf-8')
        offsets.append((len(ids), len(kb), len(strs), len(vb)))
        ids += kb + b'\x00'
        strs += vb + b'\x00'
    n = len(keys)
    keystart = 7 * 4 + 16 * n
    valuestart = keystart + len(ids)
    koffsets = []
    voffsets = []
    for o1, l1, o2, l2 in offsets:
        koffsets += [l1, o1 + keystart]
        voffsets += [l2, o2 + valuestart]
    out = struct.pack('Iiiiiii', 0x950412DE, 0, n, 7 * 4, 7 * 4 + n * 8, 0, 0)
    out += struct.pack('%di' % len(koffsets), *koffsets)
    out += struct.pack('%di' % len(voffsets), *voffsets)
    out += ids + strs
    with open(path, 'wb') as f:
        f.write(out)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    po = sys.argv[1]
    mo = sys.argv[2] if len(sys.argv) > 2 else po[:-3] + '.mo'
    write_mo(parse(po), mo)
    print('wrote', mo)
