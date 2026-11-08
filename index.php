<?php
  require_once 'config/config.php';
  $appName = $appPublicName ?? 'PLEIADES';
  $appDescription = 'Play '.$appName.' online for free in your browser. Faithful remake of the 1981 Tehkan arcade shooter Pleiads with no download required.';
  $appPrefix = 'pl';
  $appNoscript =
    '<h1>'.$appName.'</h1>'.
    '<p>Pleiads (Pleiades) is the 1981 arcade shooter by Tehkan, licensed to Centuri in the USA. '.
    'A successor of Phoenix, it sends you through four phases: swarms of morphing space monsters, '.
    'diving attackers, the battle with the mother ship and finally the landing sequence, where your '.
    'ship returns to the city and a precise landing earns a bonus.</p>'.
    '<p>This is a faithful remake of the Tehkan arcade version that runs directly in your web browser. '.
    'There is nothing to install and nothing to download — just open the page and play. '.
    'Please enable JavaScript to start the game.</p>'.
    '<p><a href="about">More about Pleiads and this remake</a></p>';
  $appOpenGraph = [
    'image' => 'images/poster.png',
  ];
  $appJsonLd = [
    'genre' => 'Shoot \'em up',
    'isBasedOn' => [
      '@type' => 'VideoGame',
      'name' => 'Pleiads',
      'alternateName' => 'Pleiades',
      'publisher' => [
        ['@type' => 'Organization', 'name' => 'Tehkan'],
        ['@type' => 'Organization', 'name' => 'Centuri'],
      ],
      'datePublished' => '1981',
      'gamePlatform' => 'Arcade',
    ],
  ];
  require_once 'app/svision/php/main.php';
