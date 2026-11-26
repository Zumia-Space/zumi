//! R4b item 4: the word error rate must not count a number written as a digit against the same number spoken as words
//! ("1" = "một", "8" = "tám", "23" = "hai mươi ba"), nor punctuation or letter case. A real mistake still counts.
use zumi_stt::wer::{normalize, wer};

#[test]
fn a_digit_and_the_vietnamese_number_word_are_the_same_word() {
    assert_eq!(wer("Chọn phương án một", "Chọn phương án 1."), 0.0);
    assert_eq!(wer("Chọn phương án 1", "chọn phương án một"), 0.0);
    assert_eq!(wer("Nhắc tôi lúc tám giờ tối", "Nhắc tôi lúc 8 giờ tối."), 0.0);
    for (word, digit) in [("không", "0"), ("một", "1"), ("hai", "2"), ("ba", "3"), ("bốn", "4"), ("năm", "5"), ("sáu", "6"), ("bảy", "7"), ("tám", "8"), ("chín", "9"), ("mười", "10")] {
        assert_eq!(wer(word, digit), 0.0, "{word} = {digit}");
    }
}

#[test]
fn two_word_numbers_are_one_number() {
    assert_eq!(wer("lúc mười một giờ", "lúc 11 giờ"), 0.0);
    assert_eq!(wer("hai mươi ba", "23"), 0.0);
    assert_eq!(wer("hai mươi lăm người", "25 người"), 0.0, "lăm after a ten is 5");
    assert_eq!(wer("ba mươi mốt", "31"), 0.0, "mốt after a ten is 1");
    assert_eq!(wer("năm mươi", "50"), 0.0);
    assert_eq!(wer("twenty three people", "23 people"), 0.0);
    assert_eq!(wer("seventeen", "17"), 0.0);
    assert_eq!(wer("eight o'clock", "8 o'clock"), 0.0);
}

#[test]
fn a_wrong_number_is_still_a_mistake_and_so_is_a_stripped_mark() {
    assert!((wer("chọn phương án một", "chọn phương án hai") - 0.25).abs() < 1e-9);
    assert!((wer("chọn phương án một", "chọn phương án 2") - 0.25).abs() < 1e-9);
    assert!(wer("lúc tám giờ", "lúc 9 giờ") > 0.0);
    assert!(wer("Chọn phương án một", "chon phuong an mot") > 0.9, "a stripped Vietnamese mark is another word");
    assert!(wer("hai mươi ba", "22") > 0.0);
}

#[test]
fn case_and_punctuation_do_not_count() {
    assert_eq!(wer("MỘT, hai; ba!", "1 2 3"), 0.0);
    assert_eq!(wer("Please open the board.", "please, open the BOARD"), 0.0);
    assert_eq!(wer("hello", "\"hello\"…"), 0.0);
}

#[test]
fn normalize_gives_the_canonical_words() {
    assert_eq!(normalize("Chọn phương án MỘT."), vec!["chọn", "phương", "án", "1"]);
    assert_eq!(normalize("hai mươi ba người"), vec!["23", "người"]);
    assert_eq!(normalize("một hai ba"), vec!["1", "2", "3"], "number words that do not form a ten stay separate");
    assert_eq!(normalize("  "), Vec::<String>::new());
}
