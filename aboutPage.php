<?php

require_once 'app/svision/php/abstractAboutPage.php';

/**
 * The /about page: the story of the original Pleiads and this remake.
 * PL-M2 placeholder text; the final content comes with PL-M7/PL-M8.
 */
class AboutPage extends AbstractAboutPage {

  protected function aboutData() {
    return [
      'image' => 'images/cover.png',
      'sections' => [
        [
          'heading' => 'The original game (1981)',
          'html' =>
            '<p>Pleiads (spelled "Pleiades" on the Centuri cabinets in the USA) was released by Tehkan '.
            'in 1981 as a successor of Phoenix. The game runs in four phases: morphing space monsters, '.
            'diving attackers, the battle with the mother ship and the landing sequence back on the '.
            'planet, where a precise landing earns a bonus.</p>',
        ],
        [
          'heading' => 'This remake',
          'html' =>
            '<p>This is a faithful remake of the Tehkan arcade version: the original game logic is being '.
            'rewritten for the web browser from the program ROM, not emulated. It runs directly in your '.
            'browser — nothing to install, nothing to download. Keyboard, touch controls and gamepads '.
            'are supported.</p>'.$this->installNote(),
        ],
        [
          'heading' => 'Other games',
          'html' =>
            '<p>This remake is one of a growing collection of classic games from the 8-bit and 16-bit era '.
            '— ZX Spectrum, Commodore 64, arcade and more — rebuilt faithfully on the same library and '.
            'playable in your browser, free of charge. Browse the whole collection at '.
            '<a href="https://retrogames.free/" target="_blank" rel="noopener">retrogames.free</a>.</p>',
        ],
      ],
      'links' => [
        ['label' => 'Pleiads on Wikipedia', 'url' => 'https://en.wikipedia.org/wiki/Pleiads'],
      ],
      'footer' =>
        '<p>An unofficial fan remake. The original game and its artwork belong to their authors (Tehkan). '.
        'The remake\'s source code is licensed under <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a>.</p>',
    ];
  } // aboutData

} // AboutPage
