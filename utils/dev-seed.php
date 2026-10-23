<?php

/*
 * Development helper: fills the database with sample spots (and generated
 * cover images) so the UI can be designed and tested without a Usenet server.
 *
 *   docker compose exec -u www-data spotweb php utils/dev-seed.php [count]
 *
 * Never run this on a real installation; it only adds fake rows.
 */

if (PHP_SAPI !== 'cli') {
    exit('dev-seed.php can only be run from the console');
}

require_once __DIR__.'/../vendor/autoload.php';

$count = isset($argv[1]) ? max(1, (int) $argv[1]) : 120;

$bootstrap = new Bootstrap();
$daoFactory = $bootstrap->getDaoFactory();
$spotDao = $daoFactory->getSpotDao();

$imgDir = __DIR__.'/../images/seed';
@mkdir($imgDir, 0775, true);

$titles = [
    0 => ['The Last Horizon', 'Midnight in Amsterdam', 'Dark Waters Rising', 'Kingdom of Ash', 'Neon Skyline', 'A Quiet Storm', 'The Cartographer', 'Red Desert', 'Winter Harbour', 'Echoes of Tomorrow', 'Paper Hearts', 'The Long Way Home', 'Iron Valley S02E04', 'Blackwater S01E09', 'Northern Lights S03E01', 'The Heist Crew S01E03'],
    1 => ['Electric Dreams - Greatest Hits', 'Live at the Paradiso', 'Summer Sessions Vol. 2', 'Deep House Collection 2026', 'Acoustic Evenings', 'The Jazz Cellar Tapes'],
    2 => ['Starfall Odyssey', 'Dungeon Architects', 'Rally Masters 5', 'Pixel Kingdom', 'Orbital Command'],
    3 => ['PhotoForge Pro 12', 'CodeWriter IDE 2026', 'AudioLab Studio', 'VectorCraft Suite'],
];
$posters = ['Anna', 'Bram', 'Chantal', 'Dirk', 'Esmee', 'Floris', 'Gerda', 'Hugo'];
$descriptions = [
    "Een prachtige release in uitstekende kwaliteit.\n\nGenre: Drama / Thriller\nDuur: 118 minuten\nTaal: Engels gesproken, Nederlands ondertiteld.\n\nVeel kijkplezier!",
    "Complete release with all extras.\n\nVideo: x264 1080p\nAudio: DTS 5.1\nSubs: NL, EN\n\nEnjoy.",
    "Fresh rip, verified and checked. Please seed responsibly and leave a comment.",
];
$palette = [[37, 99, 235], [220, 38, 38], [22, 163, 74], [217, 119, 6], [124, 58, 237], [8, 145, 178], [219, 39, 119], [71, 85, 105]];

function makeCover($path, $title, $color)
{
    $w = 300;
    $h = 440;
    $im = imagecreatetruecolor($w, $h);
    for ($y = 0; $y < $h; $y++) {
        $f = $y / $h;
        $c = imagecolorallocate($im, (int) ($color[0] * (1 - 0.6 * $f)), (int) ($color[1] * (1 - 0.6 * $f)), (int) ($color[2] * (1 - 0.6 * $f)));
        imageline($im, 0, $y, $w, $y, $c);
    }
    $white = imagecolorallocate($im, 255, 255, 255);
    $words = explode(' ', preg_replace('/ S\d\dE\d\d.*/', '', $title));
    $y = 150;
    foreach ($words as $word) {
        imagestring($im, 5, 24, $y, strtoupper($word), $white);
        $y += 22;
    }
    imagejpeg($im, $path, 85);
    imagedestroy($im);
}

$spots = [];
$fullSpots = [];
$now = time();
for ($i = 0; $i < $count; $i++) {
    $cat = $i % 10 < 7 ? 0 : (($i % 10) - 6);          // mostly movies/series
    $list = $titles[$cat];
    $title = $list[$i % count($list)].($i >= count($list) ? ' ('.(2020 + $i % 7).')' : '');
    $stamp = $now - ($i * 5400) - mt_rand(0, 3000);
    $messageid = 'seed'.$i.'.'.substr(md5($title.$i), 0, 12).'@spot.net';
    $poster = $posters[$i % count($posters)];
    $subs = [
        0 => ['a' => 'a9|', 'b' => 'b'.(1 + $i % 3).'|', 'c' => 'c'.($i % 2 ? 0 : 1).'|', 'd' => 'd'.(1 + $i % 20).'|', 'z' => 'z0|'],
        1 => ['a' => 'a0|', 'b' => 'b0|', 'c' => 'c0|', 'd' => 'd'.($i % 9).'|', 'z' => 'z0|'],
        2 => ['a' => 'a0|', 'b' => 'b0|', 'c' => 'c'.($i % 8).'|', 'd' => '', 'z' => 'z0|'],
        3 => ['a' => 'a0|', 'b' => 'b0|', 'c' => '', 'd' => '', 'z' => 'z0|'],
    ][$cat];

    $cover = $imgDir.'/'.$i.'.jpg';
    if ($cat === 0 || $i % 2 === 0) {
        makeCover($cover, $title, $palette[$i % count($palette)]);
        $imageUrl = 'http://127.0.0.1/images/seed/'.$i.'.jpg';
    } else {
        $imageUrl = '';
    }

    $filesize = (int) (mt_rand(200, 9000) * 1024 * 1024);
    $spots[] = [
        'messageid' => $messageid, 'poster' => $poster, 'title' => $title, 'tag' => '',
        'category'  => $cat, 'subcata' => $subs['a'], 'subcatb' => $subs['b'], 'subcatc' => $subs['c'],
        'subcatd'   => $subs['d'], 'subcatz' => $subs['z'], 'stamp' => $stamp, 'filesize' => $filesize,
        'spotterid' => substr(md5($poster), 0, 10),
    ];

    $xml = '<?xml version="1.0" encoding="UTF-8"?><Spotnet><Posting><Key>1</Key><Created>'.$stamp.'</Created>'
        .'<Poster>'.$poster.'</Poster><Tag></Tag><Title>'.htmlspecialchars($title).'</Title>'
        .'<Description>'.htmlspecialchars($descriptions[$i % count($descriptions)]).'</Description>'
        .'<Image>'.$imageUrl.'</Image><Category>'.str_pad((string) ($cat + 1), 2, '0', STR_PAD_LEFT).'</Category>'
        .'<Size>'.$filesize.'</Size>'
        .'<SubCat>'.$subs['a'].'</SubCat><SubCat>'.$subs['b'].'</SubCat><SubCat>'.$subs['c'].'</SubCat><SubCat>'.$subs['d'].'</SubCat><SubCat>'.$subs['z'].'</SubCat>'
        .'<NZB><Segment>seednzb'.$i.'@spot.net</Segment></NZB></Posting></Spotnet>';
    $fullSpots[] = [
        'messageid' => $messageid, 'verified' => true, 'user-signature' => '', 'user-key' => ['modulo' => '', 'exponent' => ''],
        'xml-signature' => '', 'fullxml' => $xml,
    ];
}

$spotDao->addSpots($spots, $fullSpots);
echo 'Added '.count($spots).' sample spots'.PHP_EOL;
