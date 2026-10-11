#!/bin/bash
# Smoke test against a running instance. Usage: ./smoke.sh http://127.0.0.1:3100
# WARNING: creates the first admin when the DB is empty; intended for fresh dev DBs only.
B=${1:-http://127.0.0.1:3100}
J=/tmp/cdx-a.jar; U=/tmp/cdx-u.jar; rm -f $J $U
PW='SmokeTest12345'
pass=0; failn=0
ok(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS  $1"; else failn=$((failn+1)); echo "FAIL  $1 (got $3, want $2)"; fi; }
tok(){ awk '$6=="docs_csrf"{print $7}' $1; }
req(){ # jar method path [json]
  local jar=$1 m=$2 p=$3 d=$4
  curl -s -o /tmp/cdx-out -w '%{http_code}' -b $jar -c $jar -X $m -H "x-csrf-token: $(tok $jar)" ${d:+-H 'Content-Type: application/json' -d "$d"} $B/api$p
}
curl -s -o /dev/null -c $J $B/api/me; curl -s -o /dev/null -c $U $B/api/me
ok "csrf required on POST" 403 "$(curl -s -o /dev/null -w '%{http_code}' -b $J -X POST -H 'Content-Type: application/json' -d '{}' $B/api/logout)"
ok "me unauthenticated: default system name" '{"user":null,"siteName":"Docs"}' "$(curl -s -b $J $B/api/me)"
ok "users list needs auth" 401 "$(req $J GET /users)"
ok "setup rejects weak password" 400 "$(req $J POST /setup '{"email":"a@x.com","displayName":"A","password":"short"}')"
ok "setup creates admin (with system name)" 200 "$(req $J POST /setup "{\"email\":\"admin@x.com\",\"displayName\":\"Admin\",\"password\":\"$PW\",\"siteName\":\"Smoke Docs\"}")"
ok "setup only once" 409 "$(req $U POST /setup "{\"email\":\"b@x.com\",\"displayName\":\"B\",\"password\":\"$PW\"}")"
ok "admin me" admin "$(curl -s -b $J $B/api/me | sed -E 's/.*"role":"([a-z]+)".*/\1/')"
ok "create user" 200 "$(req $J POST /users '{"email":"user@x.com","displayName":"Normal User","role":"user"}')"
TEMP=$(sed -E 's/.*"tempPassword":"([^"]+)".*/\1/' /tmp/cdx-out); UID_=$(sed -E 's/.*"user":\{"id":"([^"]+)".*/\1/' /tmp/cdx-out)
ok "duplicate email rejected" 409 "$(req $J POST /users '{"email":"user@x.com","displayName":"Dup"}')"
ok "wrong password rejected" 401 "$(req $U POST /login '{"email":"user@x.com","password":"nope"}')"
ok "user login with temp pw" 200 "$(req $U POST /login "{\"email\":\"user@x.com\",\"password\":\"$TEMP\"}")"
ok "must-change blocks api" 403 "$(req $U GET /audit)"
ok "must-change user can still load the app shell (setup status)" 200 "$(req $U GET /setup/status)"
ok "must-change user can still read branding" 200 "$(req $U GET /branding)"
ok "must-change user can read /me" 200 "$(req $U GET /me)"
ok "change pw (weak)" 400 "$(req $U POST /me/password "{\"current\":\"$TEMP\",\"next\":\"abc\"}")"
ok "change pw" 200 "$(req $U POST /me/password "{\"current\":\"$TEMP\",\"next\":\"UserNewPass123\"}")"
ok "user cannot list users" 403 "$(req $U GET /users)"
ok "user cannot see audit" 403 "$(req $U GET /audit)"
ok "user sets theme" 200 "$(req $U PATCH /me '{"theme":"light"}')"
ok "user cannot patch others" 403 "$(req $U PATCH /users/$UID_ '{"role":"admin"}')"
# 2FA for the normal user
ok "2fa setup" 200 "$(req $U POST /me/2fa/setup)"
SECRET=$(sed -E 's/.*"secret":"([^"]+)".*/\1/' /tmp/cdx-out)
code(){ docker compose exec -T app node -e "import('otplib').then(m=>console.log(m.authenticator.generate('$SECRET')))"; }
codeNext(){ docker compose exec -T app node -e "import('otplib').then(m=>{m.authenticator.options={epoch:Date.now()+30000};console.log(m.authenticator.generate('$SECRET'))})"; }
ok "2fa enable bad code" 400 "$(req $U POST /me/2fa/enable '{"code":"000000"}')"
ok "2fa enable" 200 "$(req $U POST /me/2fa/enable "{\"code\":\"$(code | tr -d '\r\n')\"}")"
curl -s -o /dev/null -c $U $B/api/me; rm -f $U; curl -s -o /dev/null -c $U $B/api/me
ok "login needs totp" 401 "$(req $U POST /login '{"email":"user@x.com","password":"UserNewPass123"}')"
ok "login totp_required msg" '{"error":"totp_required"}' "$(cat /tmp/cdx-out)"
ok "totp code used to enable 2FA cannot be replayed to log in" 401 "$(req $U POST /login "{\"email\":\"user@x.com\",\"password\":\"UserNewPass123\",\"totp\":\"$(code | tr -d '\r\n')\"}")"
NEXT=$(codeNext | tr -d '\r\n')
ok "login with a fresh totp code" 200 "$(req $U POST /login "{\"email\":\"user@x.com\",\"password\":\"UserNewPass123\",\"totp\":\"$NEXT\"}")"
U3=/tmp/cdx-u3.jar; rm -f $U3; curl -s -o /dev/null -c $U3 $B/api/me
ok "same totp code cannot be used twice" 401 "$(req $U3 POST /login "{\"email\":\"user@x.com\",\"password\":\"UserNewPass123\",\"totp\":\"$NEXT\"}")"
ok "wrong totp code rejected" 401 "$(req $U3 POST /login '{"email":"user@x.com","password":"UserNewPass123","totp":"000000"}')"
# admin powers
ok "admin reset 2fa" 200 "$(req $J POST /users/$UID_/reset-2fa)"
ok "admin reset password" 200 "$(req $J POST /users/$UID_/reset-password)"
ok "old user session killed" 401 "$(req $U GET /users)"
ok "admin disable user" 200 "$(req $J PATCH /users/$UID_ '{"isActive":false}')"
ADMIN_ID=$(curl -s -b $J $B/api/me | sed -E 's/.*"user":\{"id":"([^"]+)".*/\1/')
ok "cannot demote last admin" 409 "$(req $J PATCH /users/$ADMIN_ID '{"role":"user"}')"
ok "cannot delete self" 409 "$(req $J DELETE /users/$ADMIN_ID)"
ok "admin delete user" 200 "$(req $J DELETE /users/$UID_)"
ok "audit has entries" 200 "$(req $J GET /audit)"
# ---------- M1: links ----------
python3 - <<'PY'
# minimal valid N-page PDF generator
def make(path, n, label):
    objs = []
    objs.append("<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{3+i*2} 0 R" for i in range(n))
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n} >>")
    for i in range(n):
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Contents {4+i*2} 0 R /Resources << /Font << /F1 {3+n*2} 0 R >> >> >>")
        s = f"BT /F1 64 Tf 80 260 Td ({label} page {i+1}) Tj ET"
        objs.append(f"<< /Length {len(s)} >>\nstream\n{s}\nendstream")
    objs.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = "%PDF-1.4\n"; offs = []
    for i, o in enumerate(objs):
        offs.append(len(out.encode("latin1"))); out += f"{i+1} 0 obj\n{o}\nendobj\n"
    xref = len(out.encode("latin1"))
    out += f"xref\n0 {len(objs)+1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offs)
    out += f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    open(path, "wb").write(out.encode("latin1"))
make("/tmp/cdx-test1.pdf", 3, "ALPHA"); make("/tmp/cdx-test2.pdf", 5, "BETA")
PY
echo "not a pdf" > /tmp/cdx-fake.pdf
mp(){ # jar path curl-args...  -> multipart POST
  local jar=$1 path=$2; shift 2
  curl -s -o /tmp/cdx-out -w '%{http_code}' -b $jar -c $jar -X POST -H "x-csrf-token: $(tok $jar)" "$@" $B/api$path
}
ok "reject non-pdf upload" 400 "$(mp $J /links -F kind=file -F title=Fake -F file=@/tmp/cdx-fake.pdf)"
ok "file link needs file" 400 "$(mp $J /links -F kind=file -F title=NoFile)"
ok "slug reserved" 400 "$(mp $J /links -F kind=file -F title=T -F slug=admin -F file=@/tmp/cdx-test1.pdf)"
ok "expiry in past rejected" 400 "$(mp $J /links -F kind=file -F title=T -F expiresAt=2020-01-01T00:00:00.000Z -F file=@/tmp/cdx-test1.pdf)"
FUT=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%S.000Z)
ok "create file link (pw+expiry)" 200 "$(mp $J /links -F kind=file -F title='Pitch Deck' -F slug=pitchdeck -F password=sifre1234 -F expiresAt=$FUT -F maxViews=50 -F file=@/tmp/cdx-test1.pdf)"
LID=$(sed -E 's/.*"id":"([^"]+)".*/\1/' /tmp/cdx-out)
ok "slug uniqueness" 409 "$(mp $J /links -F kind=file -F title=T -F slug=pitchdeck -F file=@/tmp/cdx-test1.pdf)"
ok "create open file link (auto slug)" 200 "$(mp $J /links -F kind=file -F title='Open Doc' -F file=@/tmp/cdx-test2.pdf)"
OID=$(sed -E 's/.*"id":"([^"]+)".*/\1/' /tmp/cdx-out); OSLUG=$(sed -E 's/.*"slug":"([^"]+)".*/\1/' /tmp/cdx-out)
ok "public: password page" 200 "$(curl -s -o /tmp/cdx-pub -w '%{http_code}' $B/pitchdeck)"
ok "public: shows unlock form" 1 "$(grep -c 'name="password"' /tmp/cdx-pub)"
ok "public: no page images before unlock" 0 "$(grep -c '/_p/' /tmp/cdx-pub)"
ok "unlock wrong pw" 401 "$(curl -s -o /dev/null -w '%{http_code}' -d 'password=wrong' $B/pitchdeck/unlock)"
ok "unlock right pw" 303 "$(curl -s -o /dev/null -c /tmp/cdx-vis.jar -w '%{http_code}' -d 'password=sifre1234' $B/pitchdeck/unlock)"
ok "viewer after unlock" 200 "$(curl -s -o /tmp/cdx-pub -b /tmp/cdx-vis.jar -w '%{http_code}' $B/pitchdeck)"
ok "viewer lists 3 pages" 3 "$(grep -o 'class="pg"' /tmp/cdx-pub | wc -l)"
ok "viewer has no download/pdf link" 0 "$(grep -c -i -E 'download|\.pdf' /tmp/cdx-pub)"
IMG=$(grep -o '/_p/[^"]*' /tmp/cdx-pub | head -1 | sed 's/&amp;/\&/g')
ok "page image served" 200 "$(curl -s -o /tmp/cdx-img.jpg -w '%{http_code}' "$B$IMG")"
ok "page image is jpeg" "JPEG" "$(file -b /tmp/cdx-img.jpg | cut -c1-4)"
ok "image bad signature" 403 "$(curl -s -o /dev/null -w '%{http_code}' "$B$(echo $IMG | sed 's/t=.*/t=bad/')")"
ok "og image hidden when password" 404 "$(curl -s -o /dev/null -w '%{http_code}' $B/_og/pitchdeck.jpg)"
ok "open doc viewer" 200 "$(curl -s -o /tmp/cdx-pub2 -w '%{http_code}' $B/$OSLUG)"
ok "open doc has og:image" 1 "$(grep -c 'og:image' /tmp/cdx-pub2)"
ok "og image served" 200 "$(curl -s -o /dev/null -w '%{http_code}' $B/_og/$OSLUG.jpg)"
ok "unknown slug 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' $B/doesnotexist)"
ok "url link validation" 400 "$(req $J POST /links '{"kind":"url","title":"x","destinationUrl":"javascript:alert(1)"}')"
ok "create url link" 200 "$(req $J POST /links '{"kind":"url","title":"Site","slug":"go-site","destinationUrl":"https://example.com/x"}')"
ok "url redirect" "302 https://example.com/x" "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' $B/go-site)"
ok "url link: no password allowed" 400 "$(req $J POST /links '{"kind":"url","title":"x","password":"abcd","destinationUrl":"https://example.com"}')"
# new version keeps slug + stats
ok "add version" 200 "$(mp $J /links/$OID/versions -F note=v2 -F file=@/tmp/cdx-test1.pdf)"
ok "version list has 2 versions" 2 "$(curl -s -b $J $B/api/links/$OID | grep -o '"versionNo":[0-9]*' | sort -u | wc -l)"
ok "viewer now has 3 pages" 3 "$(curl -s $B/$OSLUG | grep -o 'class="pg"' | wc -l)"
V1=$(curl -s -b $J $B/api/links/$OID | grep -o '"id":"[^"]*","versionNo":1' | sed -E 's/"id":"([^"]+)".*/\1/')
ok "rollback to v1" 200 "$(req $J POST /links/$OID/versions/$V1/activate)"
ok "viewer back to 5 pages" 5 "$(curl -s $B/$OSLUG | grep -o 'class="pg"' | wc -l)"
# status / limits
ok "disable link" 200 "$(req $J PATCH /links/$OID '{"status":"disabled"}')"
ok "disabled link is 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' $B/$OSLUG)"
ok "enable link" 200 "$(req $J PATCH /links/$OID '{"status":"active"}')"
ok "set max views=1" 200 "$(req $J PATCH /links/$OID '{"maxViews":1}')"
curl -s -o /dev/null -A 'Mozilla/5.0 (X11; Linux) Chrome/130' $B/$OSLUG
ok "max views reached -> 404" 404 "$(curl -s -o /dev/null -A 'Mozilla/5.0 Chrome/130' -w '%{http_code}' $B/$OSLUG)"
ok "admin preview does not count" 200 "$(curl -s -o /dev/null -b $J -w '%{http_code}' $B/pitchdeck)"
ok "list links" 200 "$(req $J GET /links)"
ok "qr svg" 200 "$(curl -s -o /dev/null -b $J -w '%{http_code}' $B/api/links/$LID/qr.svg)"
# a normal user sees only their own links
req $J POST /users '{"email":"u2@x.com","displayName":"U2","role":"user","password":"TempPass12345"}' >/dev/null
U2=/tmp/cdx-u2.jar; rm -f $U2; curl -s -o /dev/null -c $U2 $B/api/me
req $U2 POST /login '{"email":"u2@x.com","password":"TempPass12345"}' >/dev/null
req $U2 POST /me/password '{"current":"TempPass12345","next":"U2NewPass12345"}' >/dev/null
ok "user sees no foreign links" '{"links":[]}' "$(curl -s -b $U2 $B/api/links)"
ok "user cannot read foreign link" 404 "$(req $U2 GET /links/$LID)"
ok "user cannot delete foreign link" 404 "$(req $U2 DELETE /links/$LID)"
ok "user creates own url link" 200 "$(req $U2 POST /links '{"kind":"url","title":"Mine","destinationUrl":"https://example.org"}')"
ok "admin sees all links (incl. u2)" 1 "$(curl -s -b $J $B/api/links | grep -c u2@x.com)"
ok "delete link" 200 "$(req $J DELETE /links/$LID)"
ok "deleted link 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' $B/pitchdeck)"
ok "files removed from disk" 0 "$(docker compose exec -T app sh -c "ls /data/docs/$LID 2>/dev/null | wc -l" | tr -d '\r\n')"
# ---------- recipient + tags + English-only ----------
ok "create file link with recipient+tags (multipart)" 200 "$(mp $J /links -F kind=file -F title='For Jane' -F slug=jane-deck -F 'recipient=Jane Doe - Acme Ventures' -F 'tags=Investor, Seed Round,investor' -F file=@/tmp/cdx-test1.pdf)"
JID=$(sed -E 's/.*"id":"([^"]+)".*/\1/' /tmp/cdx-out)
ok "recipient stored" 1 "$(curl -s -b $J $B/api/links/$JID | grep -c '"recipient":"Jane Doe - Acme Ventures"')"
ok "tags normalized + deduped" 1 "$(curl -s -b $J $B/api/links/$JID | grep -c '"tags":\["investor","seed-round"\]')"
ok "url link with recipient+tags (json)" 200 "$(req $J POST /links '{"kind":"url","title":"R","recipient":"Bob","tags":["VIP","Q4 2026"],"destinationUrl":"https://example.com"}')"
ok "tags normalized (json)" 1 "$(curl -s -b $J $B/api/links | grep -c '"tags":\["vip","q4-2026"\]')"
ok "patch recipient and tags" 200 "$(req $J PATCH /links/$JID '{"recipient":"Jane D.","tags":["partner"]}')"
ok "patched values visible" 1 "$(curl -s -b $J $B/api/links/$JID | grep -c '"recipient":"Jane D.".*"tags":\["partner"\]')"
ok "clear recipient" 200 "$(req $J PATCH /links/$JID '{"recipient":null}')"
ok "too many tags rejected" 400 "$(req $J PATCH /links/$JID '{"tags":["a","b","c","d","e","f","g","h","i","j","k"]}')"
ok "public page 404 is English" 1 "$(curl -s $B/nope-nope | grep -c 'Link not found')"
ok "public page has lang=en" 1 "$(curl -s $B/jane-deck | grep -c '<html lang="en">')"
ok "no Turkish letters in public html" 0 "$(curl -s $B/jane-deck $B/nope-nope | grep -c -E 'ş|ğ|ı|İ|ç|ö|ü')"
ok "validation message is English" 1 "$(req $J POST /links '{"kind":"url","title":"x","slug":"A","destinationUrl":"https://e.com"}' >/dev/null; grep -c 'Slug must be' /tmp/cdx-out)"
# ---------- M2: tracking + stats ----------
UA_IPHONE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
UA_LI='Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30'
UA_WIN='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
ok "create stats test link" 200 "$(mp $J /links -F kind=file -F title='Stats Deck' -F slug=statsdeck -F 'recipient=Alice - Seed Fund' -F file=@/tmp/cdx-test2.pdf)"
SID=$(sed -E 's/.*"id":"([^"]+)".*/\1/' /tmp/cdx-out)
rm -f /tmp/cdx-v1.jar /tmp/cdx-v3.jar
# visit 1: iPhone/Safari from a LinkedIn page, tagged ?src=alice, located in New York
curl -s -c /tmp/cdx-v1.jar -A "$UA_IPHONE" -e 'https://www.linkedin.com/feed/' -H 'CF-IPCountry: US' -H 'CF-IPCity: New York' "$B/statsdeck?src=alice" > /tmp/cdx-s1.html
VID1=$(grep -o 'id="trk" data-vid="[0-9]*"' /tmp/cdx-s1.html | grep -o '[0-9]*'); VT1=$(grep -o 'data-vt="[^"]*"' /tmp/cdx-s1.html | sed 's/data-vt="//; s/"//')
ok "viewer embeds tracking ids" 1 "$([ -n "$VID1" ] && [ -n "$VT1" ] && echo 1 || echo 0)"
ok "beacon with bad token" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: text/plain' -d '{"t":"bad","a":1000,"o":1000,"p":1,"d":{}}' $B/_t/$VID1)"
ok "beacon rejects garbage" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: text/plain' -d '{"nope":true}' $B/_t/$VID1)"
ok "beacon accepted (text/plain)" 204 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: text/plain' -d "{\"t\":\"$VT1\",\"a\":30000,\"o\":50000,\"p\":3,\"d\":{\"1\":10000,\"2\":5000,\"3\":15000},\"w\":390,\"h\":844,\"l\":\"en-US\"}" $B/_t/$VID1)"
ok "later beacon with bigger totals" 204 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: text/plain' -d "{\"t\":\"$VT1\",\"a\":65000,\"o\":90000,\"p\":4,\"d\":{\"1\":10000,\"2\":5000,\"3\":40000,\"4\":10000,\"99\":5000},\"w\":390,\"h\":844,\"l\":\"en-US\"}" $B/_t/$VID1)"
ok "stale (smaller) beacon cannot lower totals" 204 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: text/plain' -d "{\"t\":\"$VT1\",\"a\":1000,\"o\":2000,\"p\":1,\"d\":{\"3\":1000}}" $B/_t/$VID1)"
# visit 2: same visitor (cookie) returns on Windows/Edge, direct
curl -s -b /tmp/cdx-v1.jar -c /tmp/cdx-v1.jar -A "$UA_WIN" "$B/statsdeck" > /tmp/cdx-s2.html
# visit 3: new visitor inside the LinkedIn app (no referrer), reads to the end
curl -s -c /tmp/cdx-v3.jar -A "$UA_LI" "$B/statsdeck" > /tmp/cdx-s3.html
VID3=$(grep -o 'id="trk" data-vid="[0-9]*"' /tmp/cdx-s3.html | grep -o '[0-9]*'); VT3=$(grep -o 'data-vt="[^"]*"' /tmp/cdx-s3.html | sed 's/data-vt="//; s/"//')
ok "beacon visit 3 (read to the end)" 204 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: text/plain' -d "{\"t\":\"$VT3\",\"a\":20000,\"o\":25000,\"p\":5,\"d\":{\"5\":20000}}" $B/_t/$VID3)"
# bots and the admin's own views must not count by default
curl -s -o /dev/null -A 'Googlebot/2.1 (+http://www.google.com/bot.html)' $B/statsdeck
curl -s -o /dev/null -b $J -A "$UA_WIN" $B/statsdeck
ST=$(curl -s -b $J "$B/api/links/$SID/stats?range=30d&tz=UTC")
num(){ echo "$ST" | sed -E "s/.*$1.*/\1/"; }
ok "stats: 3 counted views" 3 "$(echo "$ST" | sed -E 's/.*"summary":\{"views":([0-9]+).*/\1/')"
ok "stats: 2 unique visitors" 2 "$(echo "$ST" | sed -E 's/.*"summary":\{"views":[0-9]+,"visitors":([0-9]+).*/\1/')"
ok "stats: 1 returning visitor" 1 "$(echo "$ST" | sed -E 's/.*"returningVisitors":([0-9]+).*/\1/')"
ok "stats: 1 completed (read to end)" 1 "$(echo "$ST" | sed -E 's/.*"completed":([0-9]+).*/\1/')"
ok "stats: avg active time (65s+20s)/2 = 42500" 42500 "$(echo "$ST" | sed -E 's/.*"avgActiveMs":([0-9]+).*/\1/')"
ok "stats: LinkedIn merged from referrer + in-app" 1 "$(echo "$ST" | grep -c '"name":"LinkedIn","views":2')"
ok "stats: direct visit listed" 1 "$(echo "$ST" | grep -c '"name":"Direct / unknown","views":1')"
ok "stats: src tag recorded" 1 "$(echo "$ST" | grep -c '"tags":\[{"name":"alice"')"
ok "stats: referrer URL recorded" 1 "$(echo "$ST" | grep -c 'https://www.linkedin.com/feed/')"
ok "stats: country + city from Cloudflare headers" 2 "$(echo "$ST" | grep -o -E '"name":"(US|New York)"' | wc -l)"
ok "stats: Safari + Edge parsed" 2 "$(echo "$ST" | grep -o -E '"name":"(Safari|Edge)"' | sort -u | wc -l)"
ok "stats: iOS + Windows parsed" 2 "$(echo "$ST" | grep -o -E '"name":"(iOS|Windows)"' | sort -u | wc -l)"
ok "stats: mobile + desktop devices" 2 "$(echo "$ST" | grep -o -E '"name":"(mobile|desktop)"' | sort -u | wc -l)"
ok "stats: 5 pages in page report" 5 "$(echo "$ST" | grep -o '"pageNo":' | wc -l)"
ok "stats: page 3 reached by 2, avg dwell 40000 (not lowered by stale beacon)" 1 "$(echo "$ST" | grep -c '"pageNo":3,"reached":2,"avgDwellMs":40000')"
ok "stats: out-of-range page 99 ignored" 0 "$(echo "$ST" | grep -c '"pageNo":99')"
ok "stats: page 5 reached by 1" 1 "$(echo "$ST" | grep -c '"pageNo":5,"reached":1')"
ok "stats: timeline has data" 1 "$(echo "$ST" | grep -c '"timeline":\[.*"views":3')"
STB=$(curl -s -b $J "$B/api/links/$SID/stats?range=30d&bots=1&owner=1")
ok "stats: bots+owner included on request" 5 "$(echo "$STB" | sed -E 's/.*"summary":\{"views":([0-9]+).*/\1/')"
ok "views list" 200 "$(req $J GET "/links/$SID/views?range=30d&limit=10")"
ok "views list shows tagged source" 1 "$(grep -c 'LinkedIn · alice' /tmp/cdx-out)"
ok "views list: returning visitor flagged" 1 "$(grep -c '"visitNo":2' /tmp/cdx-out)"
ok "views list: longest page recorded" 1 "$(grep -c '"topPage":3' /tmp/cdx-out)"
CSV=$(curl -s -b $J "$B/api/links/$SID/views.csv?range=30d")
ok "csv header" 1 "$(echo "$CSV" | head -1 | grep -c '^startedAt,visitor,visitNo')"
ok "csv rows (3 visits)" 4 "$(echo "$CSV" | wc -l)"
ok "overview endpoint" 200 "$(req $J GET "/stats/overview?range=30d&tz=UTC")"
ok "overview lists top link with recipient" 1 "$(grep -c 'Alice - Seed Fund' /tmp/cdx-out)"
ok "overview has by-user table for admin" 1 "$(grep -c '"byUser":\[{' /tmp/cdx-out)"
ok "user cannot read foreign stats" 404 "$(req $U2 GET "/links/$SID/stats?range=30d")"
ok "user cannot export foreign csv" 404 "$(curl -s -o /dev/null -w '%{http_code}' -b $U2 "$B/api/links/$SID/views.csv")"
ok "user overview excludes foreign data" 0 "$(req $U2 GET "/stats/overview?range=30d" >/dev/null; grep -c 'Alice - Seed Fund' /tmp/cdx-out)"
ok "stats need auth" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/links/$SID/stats")"
# ---------- stamp + per-version + per-visitor ----------
stampstat(){ # linkId versionNo -> "<red pixels> <gray pixels>" in the top-right region of page 1
  docker compose exec -T app node -e "
const sharp=require('sharp');
(async()=>{const f='/data/docs/$1/v$2/pages/1.jpg';const m=await sharp(f).metadata();
const reg=await sharp(f).extract({left:Math.round(m.width*0.45),top:0,width:Math.round(m.width*0.55),height:Math.round(m.height*0.12)}).raw().toBuffer({resolveWithObject:true});
let red=0,gray=0;for(let i=0;i<reg.data.length;i+=reg.info.channels){const r=reg.data[i],g=reg.data[i+1],b=reg.data[i+2];if(r>150&&g<90&&b<90)red++;if(r>215&&r<240&&Math.abs(r-g)<8&&Math.abs(g-b)<12)gray++;}
console.log(red+' '+gray);})()" | tr -d '\r\n'
}
stamped(){ local s; s=$(stampstat "$1" "$2"); set -- $s; if [ "$1" -gt 100 ] && [ "$2" -gt 1000 ]; then echo yes; else echo no; fi; }
ok "stamp: link with recipient is stamped (red text on gray box)" yes "$(stamped $SID 1)"
ok "stamp: link without recipient is not stamped" no "$(stamped $OID 1)"
ok "stamp: turn off" 200 "$(req $J PATCH /links/$SID '{"stamp":false}')"
ok "stamp: page re-rendered without stamp" no "$(stamped $SID 1)"
ok "stamp: turn on again" 200 "$(req $J PATCH /links/$SID '{"stamp":true}')"
ok "stamp: back on the page" yes "$(stamped $SID 1)"
ok "stamp: non-ASCII recipient" 200 "$(req $J PATCH /links/$SID '{"recipient":"Şule Ünal — Çelik Ltd."}')"
ok "stamp: non-ASCII recipient renders" yes "$(stamped $SID 1)"
ok "stamp: original PDF kept untouched" 1 "$(docker compose exec -T app sh -c "head -c 5 /data/docs/$SID/v1/original.pdf" | grep -c '%PDF-')"
ok "stamp: add version 2" 200 "$(mp $J /links/$SID/versions -F note=v2 -F file=@/tmp/cdx-test1.pdf)"
ok "stamp: new version inherits the stamp" yes "$(stamped $SID 2)"
ok "stamp: recipient cleared" 200 "$(req $J PATCH /links/$SID '{"recipient":null}')"
ok "stamp: all versions re-rendered (v1)" no "$(stamped $SID 1)"
ok "stamp: all versions re-rendered (v2)" no "$(stamped $SID 2)"
ok "stamp: recipient set again" 200 "$(req $J PATCH /links/$SID '{"recipient":"Alice - Seed Fund"}')"
ok "stamp: v1 stamped again" yes "$(stamped $SID 1)"
ok "stamp: v2 stamped again" yes "$(stamped $SID 2)"
ok "stamp: create with stamp off" 200 "$(mp $J /links -F kind=file -F title=NoStamp -F slug=nostamp -F 'recipient=Bob' -F stamp=0 -F file=@/tmp/cdx-test1.pdf)"
NSID=$(sed -E 's/.*"id":"([^"]+)".*/\1/' /tmp/cdx-out)
ok "stamp: created with stamp off is clean" no "$(stamped $NSID 1)"
ok "stamp: flag stored" 1 "$(curl -s -b $J $B/api/links/$NSID | grep -c '"stamp":false')"
# --- per-version stats (SID has v1 [3 visits above] and v2 [live]) ---
curl -s -o /tmp/cdx-s4.html -A "$UA_WIN" "$B/statsdeck"
VID4=$(grep -o 'id="trk" data-vid="[0-9]*"' /tmp/cdx-s4.html | grep -o '[0-9]*'); VT4=$(grep -o 'data-vt="[^"]*"' /tmp/cdx-s4.html | sed 's/data-vt="//; s/"//')
ok "visit on v2 beacon" 204 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: text/plain' -d "{\"t\":\"$VT4\",\"a\":12000,\"o\":15000,\"p\":3,\"d\":{\"2\":12000}}" $B/_t/$VID4)"
curl -s -b $J "$B/api/links/$SID" > /tmp/cdx-ver.json
V1ID=$(grep -o '"id":"[^"]*","versionNo":1' /tmp/cdx-ver.json | sed -E 's/"id":"([^"]+)".*/\1/'); V2ID=$(grep -o '"id":"[^"]*","versionNo":2' /tmp/cdx-ver.json | sed -E 's/"id":"([^"]+)".*/\1/')
SV1=$(curl -s -b $J "$B/api/links/$SID/stats?range=30d&version=$V1ID")
SV2=$(curl -s -b $J "$B/api/links/$SID/stats?range=30d&version=$V2ID")
SALL=$(curl -s -b $J "$B/api/links/$SID/stats?range=30d")
ok "version stats: v1 has its 3 views" 3 "$(echo "$SV1" | sed -E 's/.*"summary":\{"views":([0-9]+).*/\1/')"
ok "version stats: v2 has only its own view" 1 "$(echo "$SV2" | sed -E 's/.*"summary":\{"views":([0-9]+).*/\1/')"
ok "version stats: all versions = 4" 4 "$(echo "$SALL" | sed -E 's/.*"summary":\{"views":([0-9]+).*/\1/')"
ok "version stats: v2 avg active = 12000" 12000 "$(echo "$SV2" | sed -E 's/.*"summary":\{[^}]*"avgActiveMs":([0-9]+).*/\1/')"
ok "version stats: breakdown lists both versions" 2 "$(echo "$SALL" | grep -o '"versionNo":[12]' | sort -u | wc -l)"
ok "version stats: v1 row has 3 views" 1 "$(echo "$SALL" | grep -c '"versionNo":1,"pageCount":5[^}]*"views":3')"
ok "version stats: page report follows the selected version" 5 "$(echo "$SV1" | grep -o '"pageNo":' | wc -l)"
ok "version stats: v2 page report has 3 pages" 3 "$(echo "$SV2" | grep -o '"pageNo":' | wc -l)"
ok "version stats: visits list filtered" 200 "$(req $J GET "/links/$SID/views?range=30d&version=$V2ID")"
ok "version stats: visits list has 1 entry" 1 "$(grep -o '"startedAt"' /tmp/cdx-out | wc -l)"
ok "version stats: bad version id rejected" 400 "$(req $J GET "/links/$SID/stats?version=not-a-uuid")"
# --- per-visitor stats ---
ok "visitors list" 200 "$(req $J GET "/links/$SID/visitors?range=30d")"
ok "visitors: 3 distinct visitors (cookie-less visit 4 is its own)" 3 "$(grep -o '"key":"[0-9a-f]\{12\}"' /tmp/cdx-out | sort -u | wc -l)"
RKEY=$(grep -o '"key":"[0-9a-f]*","visits":2' /tmp/cdx-out | sed -E 's/"key":"([0-9a-f]+)".*/\1/')
ok "visitors: the returning visitor has 2 visits" 12 "${#RKEY}"
ok "visitors: totals per visitor (65s)" 1 "$(grep -c '"totalActiveMs":65000' /tmp/cdx-out)"
ok "visitor detail" 200 "$(req $J GET "/links/$SID/visitors/$RKEY?range=all&bots=1&owner=1")"
ok "visitor detail: 2 visits" 2 "$(sed -E 's/.*"summary":\{"visits":([0-9]+).*/\1/' /tmp/cdx-out)"
ok "visitor detail: time per page (page 3 = 40000)" 1 "$(grep -c '"pageNo":3,"totalDwellMs":40000' /tmp/cdx-out)"
ok "visitor detail: visit list" 2 "$(grep -o '"visitNo":' /tmp/cdx-out | wc -l)"
ok "visitor detail: unknown key" 404 "$(req $J GET "/links/$SID/visitors/000000000000?range=all")"
ok "visitor detail: bad key" 400 "$(req $J GET "/links/$SID/visitors/xyz")"
ok "visitor detail: other user blocked" 404 "$(req $U2 GET "/links/$SID/visitors/$RKEY")"
ok "visitors list: other user blocked" 404 "$(req $U2 GET "/links/$SID/visitors")"
# ---------- branding + hardening ----------
python3 - <<'PY'
import struct, zlib
def png(path, w, h, rgba):
    raw = b''.join(b'\x00' + bytes(rgba) * w for _ in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
png('/tmp/cdx-logo.png', 240, 60, (230, 230, 240, 255))
PY
cat > /tmp/cdx-logo.svg <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 10"><rect width="40" height="10" fill="#222"/></svg>
SVG
echo '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' > /tmp/cdx-bad1.svg
echo '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="1" height="1"/></svg>' > /tmp/cdx-bad2.svg
echo '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://evil.example/x.png"/></svg>' > /tmp/cdx-bad3.svg
echo '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>hi</div></foreignObject></svg>' > /tmp/cdx-bad4.svg
echo '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.example/a.css);</style></svg>' > /tmp/cdx-bad5.svg
head -c 2000000 /dev/urandom > /tmp/cdx-big.bin
echo 'plain text, not an image' > /tmp/cdx-notimg.txt
ok "branding endpoint is public" 1 "$(curl -s $B/api/branding | grep -c '"siteName":"Smoke Docs","hasLogoDark":false,"hasLogoLight":false')"
ok "default logo served (dark theme)" 1 "$(curl -s $B/brand/logo/dark | grep -c 'stroke="#E8EAF0"')"
ok "default logo served (light theme)" 1 "$(curl -s $B/brand/logo/light | grep -c 'stroke="#12151C"')"
ok "unknown logo variant" 404 "$(curl -s -o /dev/null -w '%{http_code}' $B/brand/logo/other)"
ok "non-admin cannot change settings" 403 "$(req $U2 PATCH /settings '{"siteName":"Hacked"}')"
ok "non-admin cannot upload a logo" 403 "$(mp $U2 /settings/logo/dark -F file=@/tmp/cdx-logo.png)"
ok "anonymous cannot upload a logo" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -F file=@/tmp/cdx-logo.png $B/api/settings/logo/dark)"
ok "rename system (html chars)" 200 "$(req $J PATCH /settings '{"siteName":"Acme & <Docs>"}')"
ok "empty system name rejected" 400 "$(req $J PATCH /settings '{"siteName":"   "}')"
ok "api/me reflects the name" 1 "$(curl -s -b $J $B/api/me | grep -c '"siteName":"Acme & <Docs>"')"
curl -s $B/statsdeck > /tmp/cdx-pubname.html
ok "public page escapes the system name" 1 "$(grep -c 'og:site_name" content="Acme &amp; &lt;Docs&gt;"' /tmp/cdx-pubname.html)"
ok "public page has no raw html from the name" 0 "$(grep -c '<Docs>' /tmp/cdx-pubname.html)"
ok "upload PNG logo (dark)" 200 "$(mp $J /settings/logo/dark -F file=@/tmp/cdx-logo.png)"
ok "dark logo served as PNG" "image/png" "$(curl -s -o /dev/null -w '%{content_type}' $B/brand/logo/dark)"
ok "logo is sandboxed + nosniff" 2 "$(curl -sI $B/brand/logo/dark | grep -i -c -E '^(content-security-policy: .*sandbox|x-content-type-options: nosniff)')"
ok "single logo is used for both themes" "image/png" "$(curl -s -o /dev/null -w '%{content_type}' $B/brand/logo/light)"
ok "upload SVG logo (light)" 200 "$(mp $J /settings/logo/light -F file=@/tmp/cdx-logo.svg)"
ok "light logo served as SVG" "image/svg+xml" "$(curl -s -o /dev/null -w '%{content_type}' $B/brand/logo/light)"
ok "dark logo still PNG" "image/png" "$(curl -s -o /dev/null -w '%{content_type}' $B/brand/logo/dark)"
for n in 1 2 3 4 5; do ok "malicious SVG #$n rejected" 400 "$(mp $J /settings/logo/dark -F file=@/tmp/cdx-bad$n.svg)"; done
ok "dark logo unchanged after rejected uploads" "image/png" "$(curl -s -o /dev/null -w '%{content_type}' $B/brand/logo/dark)"
ok "oversized upload is rejected" 413 "$(mp $J /settings/logo/dark -F file=@/tmp/cdx-big.bin)"
ok "text file is not a logo" 400 "$(mp $J /settings/logo/dark -F file=@/tmp/cdx-notimg.txt)"
ok "branding reports both logos" 1 "$(curl -s $B/api/branding | grep -c '"hasLogoDark":true,"hasLogoLight":true')"
ok "public page uses the logo URLs (bar + favicons)" 4 "$(curl -s $B/statsdeck | grep -o '/brand/logo/\(dark\|light\)?v=[0-9]*' | wc -l)"
ok "remove dark logo" 200 "$(req $J DELETE /settings/logo/dark)"
ok "dark falls back to the light logo" "image/svg+xml" "$(curl -s -o /dev/null -w '%{content_type}' $B/brand/logo/dark)"
ok "remove light logo" 200 "$(req $J DELETE /settings/logo/light)"
ok "default logo again" 1 "$(curl -s $B/brand/logo/dark | grep -c 'stroke="#E8EAF0"')"
ok "logo files removed from disk" 0 "$(docker compose exec -T app sh -c 'ls /data/brand 2>/dev/null | wc -l' | tr -d '\r\n')"
ok "restore a normal system name" 200 "$(req $J PATCH /settings '{"siteName":"Smoke Docs"}')"
# --- hardening ---
ok "cross-origin request blocked" 403 "$(curl -s -o /tmp/cdx-out -w '%{http_code}' -b $J -X POST -H "x-csrf-token: $(tok $J)" -H 'Origin: https://evil.example' $B/api/logout)"
ok "cross-origin error code" '{"error":"bad_origin"}' "$(cat /tmp/cdx-out)"
ok "same-origin request allowed" 200 "$(curl -s -o /dev/null -w '%{http_code}' -b $J -X PATCH -H "x-csrf-token: $(tok $J)" -H "Origin: $B" -H 'Content-Type: application/json' -d '{"theme":"dark"}' $B/api/me)"
ok "malformed JSON gives a generic 400" 400 "$(curl -s -o /tmp/cdx-out -w '%{http_code}' -b $J -X POST -H "x-csrf-token: $(tok $J)" -H 'Content-Type: application/json' -d '{bad' $B/api/login)"
ok "no stack trace / internals in error body" 0 "$(grep -c -i -E 'at .*\(|node_modules|Unexpected token|SyntaxError' /tmp/cdx-out)"
ok "panel has a strict CSP" 1 "$(curl -sI $B/app/ | grep -i -c "content-security-policy: default-src 'self'.*script-src 'self'")"
ok "panel html has no inline script" 0 "$(curl -s $B/app/ | grep -c -E '<script>[^<]')"
ok "no third-party hosts in panel html" 0 "$(curl -s $B/app/ | grep -c -E 'https?://[a-z0-9.-]*(google|gstatic|cdn)')"
ok "security headers present" 3 "$(curl -sI $B/app/ | grep -i -c -E '^(x-content-type-options|x-frame-options|referrer-policy):')"
ok "hsts only over https" 0 "$(curl -sI $B/app/ | grep -i -c '^strict-transport-security')"
ok "hsts sent when proxied as https" 1 "$(curl -sI -H 'X-Forwarded-Proto: https' $B/app/ | grep -i -c '^strict-transport-security')"
ok "unauthenticated admin endpoints" 401 "$(curl -s -o /dev/null -w '%{http_code}' $B/api/users)"
ok "sql-injection-looking slug is just a 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' "$B/x'%20or%201=1--")"
ok "path traversal in image route" 404 "$(curl -s -o /dev/null -w '%{http_code}' "$B/_p/..%2F..%2Fetc/1/1?e=9999999999&t=x")"
ok "tracking endpoint ignores unknown ids" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: text/plain' -d '{"t":"x","a":1,"o":1,"p":1,"d":{}}' $B/_t/999999999)"
rm -f /tmp/cdx-sec.jar; curl -s -o /dev/null -c /tmp/cdx-sec.jar -H 'X-Forwarded-Proto: https' $B/api/me
SECTOK=$(awk '$6=="docs_csrf"{print $7}' /tmp/cdx-sec.jar)
ok "csrf cookie gets Secure over https" 1 "$(curl -s -D - -o /dev/null -H 'X-Forwarded-Proto: https' $B/api/me | grep -i '^set-cookie: docs_csrf' | grep -i -c 'secure')"
ok "session cookie gets Secure over https" 1 "$(curl -s -D - -o /dev/null -H 'X-Forwarded-Proto: https' -H "Cookie: docs_csrf=$SECTOK" -H "x-csrf-token: $SECTOK" -H 'Content-Type: application/json' -d "{\"email\":\"admin@x.com\",\"password\":\"$PW\"}" $B/api/login | grep -i '^set-cookie: docs_session' | grep -i -c 'secure')"
ok "logout" 200 "$(req $J POST /logout)"
ok "after logout unauth" 401 "$(req $J GET /users)"
echo; echo "passed=$pass failed=$failn"
