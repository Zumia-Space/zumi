//! Word error rate, the T58 measure: (substitutions + deletions + insertions) / words in the reference. Numbers, case and
//! punctuation are folded first (`normalize`), so "1" and "một" are one word.

/// Lower-case words with the punctuation around them removed. Vietnamese marks stay: "một" and "mot" are different words.
pub fn words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
        .filter(|w| !w.is_empty())
        .collect()
}

const VI_UNITS: [(&str, u32); 10] = [("không", 0), ("một", 1), ("hai", 2), ("ba", 3), ("bốn", 4), ("năm", 5), ("sáu", 6), ("bảy", 7), ("tám", 8), ("chín", 9)];
const EN_UNITS: [(&str, u32); 20] = [
    ("zero", 0), ("one", 1), ("two", 2), ("three", 3), ("four", 4), ("five", 5), ("six", 6), ("seven", 7), ("eight", 8), ("nine", 9),
    ("ten", 10), ("eleven", 11), ("twelve", 12), ("thirteen", 13), ("fourteen", 14), ("fifteen", 15), ("sixteen", 16), ("seventeen", 17), ("eighteen", 18), ("nineteen", 19),
];
const EN_TENS: [(&str, u32); 8] = [("twenty", 20), ("thirty", 30), ("forty", 40), ("fifty", 50), ("sixty", 60), ("seventy", 70), ("eighty", 80), ("ninety", 90)];

fn lookup(table: &[(&str, u32)], w: &str) -> Option<u32> {
    table.iter().find(|(name, _)| *name == w).map(|(_, v)| *v)
}

/// The digit after a ten: any unit but "không", plus the three short forms Vietnamese uses there (mốt 1, tư 4, lăm 5).
fn vi_after_ten(w: &str) -> Option<u32> {
    match w {
        "mốt" => Some(1),
        "tư" => Some(4),
        "lăm" => Some(5),
        "không" => None,
        _ => lookup(&VI_UNITS, w),
    }
}

/// An English number word below 100 written as one token ("seventeen", "twenty-three").
fn en_token(w: &str) -> Option<u32> {
    if let Some(v) = lookup(&EN_UNITS, w).or_else(|| lookup(&EN_TENS, w)) {
        return Some(v);
    }
    let (tens, unit) = w.split_once('-')?;
    Some(lookup(&EN_TENS, tens)? + lookup(&EN_UNITS, unit).filter(|u| (1..=9).contains(u))?)
}

/// The words of `text` as the word error rate compares them: lower case, no punctuation around a word, and every number
/// spoken or written below 100 as its digits ("một", "1" and "one" are the same word; "hai mươi ba", "twenty three" and "23"
/// are one word). Only number words that form a number together are joined; "một hai ba" stays three numbers. A Vietnamese
/// word with its marks stripped is still another word.
pub fn normalize(text: &str) -> Vec<String> {
    let w = words(text);
    let mut out = Vec::with_capacity(w.len());
    let mut i = 0;
    while i < w.len() {
        let (cur, next) = (w[i].as_str(), w.get(i + 1).map(String::as_str));
        // Vietnamese: "mười" and "mười một/lăm", "hai mươi" and "hai mươi mốt/lăm"
        if cur == "mười" {
            match next.and_then(vi_after_ten) {
                Some(u) => {
                    out.push((10 + u).to_string());
                    i += 2;
                }
                None => {
                    out.push("10".into());
                    i += 1;
                }
            }
            continue;
        }
        if let (Some(tens), Some("mươi")) = (lookup(&VI_UNITS, cur).filter(|t| *t >= 2), next) {
            match w.get(i + 2).map(String::as_str).and_then(vi_after_ten) {
                Some(u) => {
                    out.push((tens * 10 + u).to_string());
                    i += 3;
                }
                None => {
                    out.push((tens * 10).to_string());
                    i += 2;
                }
            }
            continue;
        }
        // English: "twenty three"
        if let (Some(tens), Some(unit)) = (lookup(&EN_TENS, cur), next.and_then(|n| lookup(&EN_UNITS, n)).filter(|u| (1..=9).contains(u))) {
            out.push((tens + unit).to_string());
            i += 2;
            continue;
        }
        out.push(match lookup(&VI_UNITS, cur).or_else(|| en_token(cur)) {
            Some(v) => v.to_string(),
            // A written number: leading zeros do not make another number.
            None if !cur.is_empty() && cur.len() <= 9 && cur.bytes().all(|b| b.is_ascii_digit()) => cur.parse::<u64>().map(|n| n.to_string()).unwrap_or_else(|_| cur.to_string()),
            None => cur.to_string(),
        });
        i += 1;
    }
    out
}

/// 0.0 = every word right. Nothing in the reference: 0.0 if nothing was heard either, else 1.0.
pub fn wer(reference: &str, heard: &str) -> f64 {
    let (r, h) = (normalize(reference), normalize(heard));
    if r.is_empty() {
        return if h.is_empty() { 0.0 } else { 1.0 };
    }
    // Levenshtein distance over words, one row at a time.
    let mut row: Vec<usize> = (0..=h.len()).collect();
    for (i, rw) in r.iter().enumerate() {
        let mut diag = row[0];
        row[0] = i + 1;
        for (j, hw) in h.iter().enumerate() {
            let up = row[j + 1];
            row[j + 1] = (diag + usize::from(rw != hw)).min(up + 1).min(row[j] + 1);
            diag = up;
        }
    }
    row[h.len()] as f64 / r.len() as f64
}
