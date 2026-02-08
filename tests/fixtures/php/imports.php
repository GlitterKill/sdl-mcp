<?php
namespace App\Http\Controllers;

// use statements with namespaces
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use App\Models\User;
use App\Services\EmailService;
use App\Repositories\UserRepository as UserRepo;

// use statements with relative namespace
use \DateTime;
use \Exception;

// require statements with string literals
require 'vendor/autoload.php';
require_once './config/app.php';
require '../helpers/functions.php';
require_once '/path/to/file.php';

// include statements with string literals
include 'templates/header.php';
include_once './partials/nav.php';
include '../config/database.php';
include_once '/shared/constants.php';

// Mixed import patterns
use Monolog\Logger;
use Monolog\Handler\StreamHandler;
require 'config/services.php';
use App\Traits\Loggable;

// use with alias
use App\Utils\StringHelper as Str;
use App\Validators\RequestValidator as Validator;

// Absolute path imports
require 'C:/xampp/htdocs/vendor/autoload.php';
include_once 'D:/projects/shared/functions.php';

// Relative path imports (current directory)
require './bootstrap/app.php';
include_once './routes/web.php';

// Relative path imports (parent directory)
require '../config/database.php';
include_once '../helpers/array.php';
